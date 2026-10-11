"""Offline phase gates for the isolated marketing preprod coordinator."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "deploy_marketing_preprod", ROOT / "scripts/deploy-marketing-preprod.py"
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
SHA = "b" * 40
PIN = "a" * 64


def inputs(evidence_root: Path):
    env = MODULE.config_module.loader.parse(
        ROOT / "infra/docker/environments/.env.preprod.example"
    )
    env.update(
        {
            "AXIOM_RELEASE_SHA": SHA,
            "AXIOM_MARKETING_TF_STATE_PREFIX": "terraform/state/marketing-preprod",
            "CLOUD_SQL_ADMIN_PASSWORD": "a" * 40,
        }
    )
    images = {
        component: f"asia-south1-docker.pkg.dev/axiom-proof/axiom-proof-preprod-images/{component}@sha256:{PIN}"
        for component in MODULE.CORE
    }
    auxiliary = {
        component: f"asia-south1-docker.pkg.dev/axiom-proof/axiom-proof-preprod-images/{component}@sha256:{PIN}"
        for component in ("migrations", "lifecycle")
    }
    release = {"release_sha": SHA, "images": images, "auxiliary_images": auxiliary}
    checks = []
    for name in MODULE.CHECKS:
        path = evidence_root / f"{name}.json"
        raw = json.dumps(
            {
                "name": name,
                "status": "passed",
                "release_sha": SHA,
                "project": "axiom-proof",
                "images": {**images, **auxiliary},
            }
        ).encode()
        path.write_bytes(raw)
        path.chmod(0o600)
        checks.append(
            {
                "name": name,
                "status": "passed",
                "evidence_sha256": hashlib.sha256(raw).hexdigest(),
                "evidence_path": str(path),
            }
        )
    clearance = {
        "release_sha": SHA,
        "project": "axiom-proof",
        "region": "asia-south1",
        "profile": "marketing",
        "images": {**images, **auxiliary},
        "checks": checks,
    }
    return env, release, clearance


def plan(*actions):
    return {
        "format_version": "1.2",
        "variables": {
            key: {"value": value}
            for key, value in {
                "project_id": "axiom-proof",
                "environment": "preprod",
                "region": "asia-south1",
                "release_sha": SHA,
                "deploy_services": False,
                "migration_account_id": "axiom-proof-preprod-migrations",
                "bootstrap_secrets": {
                    "admin_db_url": "axiom-proof-preprod-admin-db-url",
                    "auth_password": "axiom-proof-preprod-auth-password",
                    "rest_password": "axiom-proof-preprod-rest-password",
                },
            }.items()
        },
        "resource_changes": [
            {
                "address": address,
                "mode": "managed",
                "change": {
                    "actions": list(action),
                    "after": {"project": "axiom-proof"},
                },
            }
            for address, action in actions
        ],
    }


def approval(plan_sha):
    return {
        "release_sha": SHA,
        "project": "axiom-proof",
        "region": "asia-south1",
        "profile": "marketing",
        "source": "human-user",
        "allowed_phases": ["base"],
        "dry_run_plan_sha256": plan_sha,
        "rollback": {
            "preserve_database": True,
            "prevent_publication": True,
            "production": False,
        },
    }


class MarketingDeployTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.evidence_root = Path(temporary.name).resolve()
        self.root_patch = patch.object(MODULE, "ROOT", self.evidence_root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.env, self.release, self.clearance = inputs(self.evidence_root)

    def registry_clearance(self):
        return {
            **self.clearance,
            "checks": [
                item
                for item in self.clearance["checks"]
                if item["name"] in MODULE.REGISTRY_CHECKS
            ],
        }

    def test_registry_requires_exact_source_and_protected_source_clearance(self):
        target = MODULE.registry_target(self.env, SHA)
        MODULE.validate_registry_clearance(self.registry_clearance(), target=target)
        self.assertEqual(target["repository"], "axiom-proof-preprod-images")
        for env in (
            {**self.env, "AXIOM_ARTIFACT_REPOSITORY": "axiom-proof-prod-images"},
            {**self.env, "GCP_REGION": "us-central1"},
            {**self.env, "GCP_PROJECT_ID": "foreign-project"},
        ):
            with self.assertRaises(ValueError):
                MODULE.registry_target(env, SHA)
        clearance = self.registry_clearance()
        clearance["checks"][0]["status"] = "pending"
        with self.assertRaises(ValueError):
            MODULE.validate_registry_clearance(clearance, target=target)

    def test_registry_plan_and_create_only_exact_human_approval(self):
        clearance = self.registry_clearance()
        with patch.object(MODULE, "run_command", return_value=b"[]") as command:
            MODULE.registry_phase(
                "registry-plan",
                work=self.evidence_root,
                env=self.env,
                source_sha=SHA,
                approval=None,
                clearance=clearance,
            )
            self.assertEqual(command.call_count, 1)
        plan_file = self.evidence_root / "registry.plan.private.json"
        self.assertEqual(stat.S_IMODE(plan_file.stat().st_mode), 0o600)
        approved = approval(hashlib.sha256(plan_file.read_bytes()).hexdigest())
        approved["allowed_phases"] = ["registry"]
        approved["rollback"]["retain_repository"] = True
        full_name = "projects/axiom-proof/locations/asia-south1/repositories/axiom-proof-preprod-images"
        inventory = json.dumps([{"name": full_name, "format": "DOCKER"}]).encode()
        with patch.object(
            MODULE, "run_command", side_effect=[b"[]", b"", inventory]
        ) as command:
            MODULE.registry_phase(
                "registry",
                work=self.evidence_root,
                env=self.env,
                source_sha=SHA,
                approval=approved,
                clearance=clearance,
            )
            self.assertEqual(command.call_count, 3)
            self.assertIn("create", command.call_args_list[1].args[0])
        self.assertTrue(
            (self.evidence_root / "registry.receipt.private.json").is_file()
        )

    def test_registry_refuses_existing_inventory_or_unapproved_creation(self):
        clearance = self.registry_clearance()
        target = MODULE.registry_target(self.env, SHA)
        full_name = "projects/axiom-proof/locations/asia-south1/repositories/axiom-proof-preprod-images"
        with patch.object(
            MODULE,
            "run_command",
            return_value=json.dumps([{"name": full_name}]).encode(),
        ) as command:
            with self.assertRaises(ValueError):
                MODULE.registry_phase(
                    "registry-plan",
                    work=self.evidence_root,
                    env=self.env,
                    source_sha=SHA,
                    approval=None,
                    clearance=clearance,
                )
            self.assertEqual(command.call_count, 1)
        with patch.object(MODULE, "run_command", return_value=b"[]") as command:
            with self.assertRaises(ValueError):
                MODULE.registry_phase(
                    "registry",
                    work=self.evidence_root,
                    env=self.env,
                    source_sha=SHA,
                    approval={},
                    clearance=clearance,
                )
            self.assertEqual(command.call_count, 1)
        with self.assertRaises(ValueError):
            MODULE.require_absent_registry(target, [{"name": None}])

    def test_registry_cli_preflight_requires_no_fabricated_release_manifest(self):
        clearance = self.registry_clearance()
        argv = [
            "deploy-marketing-preprod.py",
            "--phase",
            "registry-plan",
            "--env-file",
            str(self.evidence_root / "selected.env"),
            "--security-clearance",
            str(self.evidence_root / "clearance.json"),
            "--work-dir",
            str(self.evidence_root),
            "--dry-run",
        ]
        with (
            patch.object(sys, "argv", argv),
            patch.object(MODULE, "clean_revision", return_value=SHA),
            patch.object(MODULE, "protected_env", return_value=self.env),
            patch.object(MODULE, "protected_json", return_value=clearance),
            patch.object(MODULE, "run_command") as cloud,
            redirect_stdout(io.StringIO()) as output,
        ):
            self.assertEqual(MODULE.main(), 0)
        cloud.assert_not_called()
        self.assertIn("no registry inventory or cloud changes", output.getvalue())

    def test_seed_candidate_binds_packaged_manifest_database_and_exclusive_adoption(
        self,
    ):
        selected = {
            "environment": "preprod",
            "project": self.env["GCP_PROJECT_ID"],
            "instance": self.env["CLOUD_SQL_INSTANCE_NAME"],
            "bucket": self.env["AXIOM_IDLE_STATE_BUCKET"],
            "object": self.env["AXIOM_IDLE_STATE_OBJECT"],
        }
        manifest = (
            json.dumps(selected, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode()
        release = {
            **self.release,
            "lifecycle_target_manifest_sha256": hashlib.sha256(manifest).hexdigest(),
        }
        database = {
            "instance": self.env["CLOUD_SQL_INSTANCE_NAME"],
            "name": self.env["CLOUD_SQL_DATABASE_NAME"],
            "connection_name": f"axiom-proof:asia-south1:{self.env['CLOUD_SQL_INSTANCE_NAME']}",
            "private_ip": "10.73.0.4",
        }
        proof = {
            "release_sha": SHA,
            "project": "axiom-proof",
            "connection_name": database["connection_name"],
            "roles_applied": True,
            "auth_applied": True,
            "series_applied": True,
            "exclusive_client_adoption": True,
            "no_other_clients": True,
        }
        actual_manifest, body = MODULE.seed_candidate(
            self.env, release, database, proof, 1_800_000_000
        )
        self.assertEqual(actual_manifest, manifest)
        self.assertEqual(
            json.loads(body)["targetHash"], release["lifecycle_target_manifest_sha256"]
        )
        for key in (
            "roles_applied",
            "auth_applied",
            "series_applied",
            "exclusive_client_adoption",
            "no_other_clients",
        ):
            with self.subTest(key=key), self.assertRaises(ValueError):
                MODULE.seed_candidate(
                    self.env, release, database, {**proof, key: False}, 1_800_000_000
                )
        with self.assertRaises(ValueError):
            MODULE.seed_candidate(
                self.env,
                {**release, "lifecycle_target_manifest_sha256": "0" * 64},
                database,
                proof,
                1_800_000_000,
            )
        with self.assertRaises(ValueError):
            MODULE.seed_candidate(
                self.env,
                release,
                {**database, "private_ip": "8.8.8.8"},
                proof,
                1_800_000_000,
            )

    def test_seed_upload_is_create_only_and_verifies_generation_pinned_bytes(self):
        selected = {
            "environment": "preprod",
            "project": "axiom-proof",
            "instance": self.env["CLOUD_SQL_INSTANCE_NAME"],
            "bucket": self.env["AXIOM_IDLE_STATE_BUCKET"],
            "object": self.env["AXIOM_IDLE_STATE_OBJECT"],
        }
        manifest = (
            json.dumps(selected, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode()
        release = {
            **self.release,
            "lifecycle_target_manifest_sha256": hashlib.sha256(manifest).hexdigest(),
        }
        database = {
            "instance": self.env["CLOUD_SQL_INSTANCE_NAME"],
            "name": self.env["CLOUD_SQL_DATABASE_NAME"],
            "connection_name": f"axiom-proof:asia-south1:{self.env['CLOUD_SQL_INSTANCE_NAME']}",
            "private_ip": "10.73.0.4",
        }
        proof = {
            "release_sha": SHA,
            "project": "axiom-proof",
            "connection_name": database["connection_name"],
            "roles_applied": True,
            "auth_applied": True,
            "series_applied": True,
            "exclusive_client_adoption": True,
            "no_other_clients": True,
        }
        _, body = MODULE.seed_candidate(
            self.env, release, database, proof, 1_800_000_000
        )

        class Response:
            def __init__(self, value):
                self.value = value

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return None

            def read(self, *_):
                return self.value

        metadata = json.dumps(
            {
                "generation": "7",
                "bucket": self.env["AXIOM_IDLE_STATE_BUCKET"],
                "name": self.env["AXIOM_IDLE_STATE_OBJECT"],
            }
        ).encode()
        with (
            patch.object(MODULE.time, "time", return_value=1_800_000_000),
            patch.object(MODULE, "run_command", return_value=b"a" * 30),
            patch.object(
                MODULE, "urlopen", side_effect=[Response(metadata), Response(body)]
            ) as transport,
        ):
            MODULE.create_only_seed(
                env=self.env,
                release=release,
                database=database,
                proof=proof,
                work=self.evidence_root,
                now=1_800_000_000,
            )
        request = transport.call_args_list[0].args[0]
        self.assertIn("ifGenerationMatch=0", request.full_url)
        self.assertEqual(request.data, body)
        self.assertIn("generation=7", transport.call_args_list[1].args[0].full_url)
        self.assertEqual(
            MODULE.protected_json(self.evidence_root / "seed.receipt.private.json")[
                "seed_generation"
            ],
            "7",
        )

    def test_seed_phase_requires_bootstrap_receipts_and_reviewed_candidate(self):
        database = {
            "instance": self.env["CLOUD_SQL_INSTANCE_NAME"],
            "name": self.env["CLOUD_SQL_DATABASE_NAME"],
            "connection_name": f"axiom-proof:asia-south1:{self.env['CLOUD_SQL_INSTANCE_NAME']}",
            "private_ip": "10.73.0.4",
        }
        selected = {
            "environment": "preprod",
            "project": "axiom-proof",
            "instance": database["instance"],
            "bucket": self.env["AXIOM_IDLE_STATE_BUCKET"],
            "object": self.env["AXIOM_IDLE_STATE_OBJECT"],
        }
        manifest = (
            json.dumps(selected, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode()
        release = {
            **self.release,
            "lifecycle_target_manifest_sha256": hashlib.sha256(manifest).hexdigest(),
        }
        proof = {
            "release_sha": SHA,
            "project": "axiom-proof",
            "connection_name": database["connection_name"],
            "roles_applied": True,
            "auth_applied": True,
            "series_applied": True,
            "exclusive_client_adoption": True,
            "no_other_clients": True,
        }
        with self.assertRaises(ValueError):
            MODULE.seed_phase(
                planning=True,
                work=self.evidence_root,
                env=self.env,
                release=release,
                database=database,
                proof=proof,
                approval=None,
            )
        for phase in ("roles", "series"):
            MODULE.protected_output(
                self.evidence_root / f"bootstrap-{phase}.receipt.private.json",
                {
                    "release_sha": SHA,
                    "project": "axiom-proof",
                    "phase": phase,
                    "database_connection_name": database["connection_name"],
                },
            )
        MODULE.protected_output(
            self.evidence_root / "bootstrap-auth.receipt.private.json",
            {
                "release_sha": SHA,
                "project": "axiom-proof",
                "database_connection_name": database["connection_name"],
                "service_ready": True,
            },
        )
        with patch.object(MODULE.time, "time", return_value=1_800_000_000):
            MODULE.seed_phase(
                planning=True,
                work=self.evidence_root,
                env=self.env,
                release=release,
                database=database,
                proof=proof,
                approval=None,
            )
        plan_file = self.evidence_root / "seed.plan.private.json"
        approved = approval(hashlib.sha256(plan_file.read_bytes()).hexdigest())
        approved["allowed_phases"] = ["seed"]
        with patch.object(MODULE, "create_only_seed") as upload:
            MODULE.seed_phase(
                planning=False,
                work=self.evidence_root,
                env=self.env,
                release=release,
                database=database,
                proof=proof,
                approval=approved,
            )
            upload.assert_called_once()
            self.assertEqual(upload.call_args.kwargs["now"], 1_800_000_000)
            with self.assertRaises(ValueError):
                MODULE.seed_phase(
                    planning=False,
                    work=self.evidence_root,
                    env=self.env,
                    release=release,
                    database=database,
                    proof={**proof, "exclusive_client_adoption": False},
                    approval=approved,
                )

    def test_bootstrap_job_descriptor_uses_private_output_and_numeric_secret_refs(self):
        env = {
            **self.env,
            "MARKETING_MIGRATION_SERVICE_ACCOUNT": "axiom-proof-preprod-migration@axiom-proof.iam.gserviceaccount.com",
        }
        database = {
            "instance": env["CLOUD_SQL_INSTANCE_NAME"],
            "name": env["CLOUD_SQL_DATABASE_NAME"],
            "connection_name": f"axiom-proof:asia-south1:{env['CLOUD_SQL_INSTANCE_NAME']}",
            "private_ip": "10.73.0.4",
        }
        release = {
            **self.release,
            "auxiliary_images": {
                "migrations": f"asia-south1-docker.pkg.dev/axiom-proof/axiom-proof-preprod-images/migrations@sha256:{PIN}"
            },
        }
        versions = {
            env["MARKETING_ADMIN_DB_URL_SECRET"]: "7",
            env["MARKETING_AUTH_PASSWORD_SECRET"]: "8",
            env["MARKETING_REST_PASSWORD_SECRET"]: "9",
        }
        identity = {
            "email": f"{env['MARKETING_MIGRATION_ACCOUNT_ID']}@axiom-proof.iam.gserviceaccount.com",
            "project": "axiom-proof",
            "release_sha": SHA,
        }
        descriptor = MODULE.bootstrap_job_descriptor(
            phase="roles",
            env=env,
            release=release,
            database=database,
            versions=versions,
            migration_identity=identity,
        )
        job = descriptor["job"]
        self.assertTrue(job["name"].endswith("-roles"))
        references = [
            item["valueSource"]["secretKeyRef"]["version"]
            for item in job["template"]["template"]["containers"][0]["env"]
            if "valueSource" in item
        ]
        self.assertEqual(references, ["7", "8", "9"])
        self.assertFalse(
            any(
                "value" in item
                for item in job["template"]["template"]["containers"][0]["env"]
                if item["name"]
                in {"SUPABASE_DB_URL", "GOTRUE_DB_PASSWORD", "REST_DB_PASSWORD"}
            )
        )
        series = MODULE.bootstrap_job_descriptor(
            phase="series",
            env=env,
            release=release,
            database=database,
            versions=versions,
            migration_identity=identity,
        )
        self.assertTrue(series["job"]["name"].endswith("-series"))
        with self.assertRaises(ValueError):
            MODULE.bootstrap_job_descriptor(
                phase="roles",
                env=env,
                release=release,
                database={**database, "private_ip": "8.8.8.8"},
                versions=versions,
                migration_identity=identity,
            )
        with self.assertRaises(ValueError):
            MODULE.bootstrap_job_descriptor(
                phase="roles",
                env=env,
                release=release,
                database=database,
                versions={**versions, env["MARKETING_ADMIN_DB_URL_SECRET"]: "latest"},
                migration_identity=identity,
            )

    def test_bootstrap_phase_requires_exact_plan_approval_and_refuses_rerun(self):
        env = {
            **self.env,
            "MARKETING_MIGRATION_SERVICE_ACCOUNT": "axiom-proof-preprod-migration@axiom-proof.iam.gserviceaccount.com",
        }
        database = {
            "instance": env["CLOUD_SQL_INSTANCE_NAME"],
            "name": env["CLOUD_SQL_DATABASE_NAME"],
            "connection_name": f"axiom-proof:asia-south1:{env['CLOUD_SQL_INSTANCE_NAME']}",
            "private_ip": "10.73.0.4",
        }
        release = {
            **self.release,
            "auxiliary_images": {
                "migrations": f"asia-south1-docker.pkg.dev/axiom-proof/axiom-proof-preprod-images/migrations@sha256:{PIN}"
            },
        }
        versions = {
            env[key]: str(index)
            for index, key in enumerate(
                (
                    "MARKETING_ADMIN_DB_URL_SECRET",
                    "MARKETING_AUTH_PASSWORD_SECRET",
                    "MARKETING_REST_PASSWORD_SECRET",
                ),
                7,
            )
        }
        identity = {
            "email": f"{env['MARKETING_MIGRATION_ACCOUNT_ID']}@axiom-proof.iam.gserviceaccount.com",
            "project": "axiom-proof",
            "release_sha": SHA,
        }
        with patch.object(MODULE, "execute_bootstrap_job") as execute:
            MODULE.bootstrap_job_phase(
                phase="roles",
                planning=True,
                work=self.evidence_root,
                env=env,
                release=release,
                database=database,
                versions=versions,
                migration_identity=identity,
                approval=None,
            )
            execute.assert_not_called()
            with self.assertRaises(ValueError):
                MODULE.bootstrap_job_phase(
                    phase="roles",
                    planning=False,
                    work=self.evidence_root,
                    env=env,
                    release=release,
                    database=database,
                    versions=versions,
                    migration_identity=identity,
                    approval={},
                )
            plan_file = self.evidence_root / "bootstrap-roles.plan.private.json"
            approved = approval(hashlib.sha256(plan_file.read_bytes()).hexdigest())
            approved["allowed_phases"] = ["bootstrap-roles"]
            MODULE.bootstrap_job_phase(
                phase="roles",
                planning=False,
                work=self.evidence_root,
                env=env,
                release=release,
                database=database,
                versions=versions,
                migration_identity=identity,
                approval=approved,
            )
            execute.assert_called_once()
            (self.evidence_root / "bootstrap-roles.receipt.private.json").write_text(
                "{}"
            )
            with self.assertRaises(ValueError):
                MODULE.bootstrap_job_phase(
                    phase="roles",
                    planning=False,
                    work=self.evidence_root,
                    env=env,
                    release=release,
                    database=database,
                    versions=versions,
                    migration_identity=identity,
                    approval=approved,
                )

    def test_job_api_path_and_exact_operation_outcome(self):
        project = "axiom-proof"
        prefix = f"projects/{project}/locations/asia-south1"
        with self.assertRaises(ValueError):
            MODULE.run_job_api(
                "POST", "projects/foreign/locations/us-central1/jobs/x", b"a" * 30, {}
            )
        with patch.object(
            MODULE,
            "run_job_api",
            return_value={
                "name": prefix + "/operations/create",
                "done": True,
                "response": {"name": prefix + "/jobs/job"},
            },
        ):
            result = MODULE.wait_job_operation(
                {"name": prefix + "/operations/create"},
                token=b"a" * 30,
                project=project,
                deadline=MODULE.time.monotonic() + 1,
            )
            self.assertEqual(result["name"], prefix + "/jobs/job")
        with self.assertRaises(ValueError):
            MODULE.wait_job_operation(
                {"name": "projects/foreign/locations/asia-south1/operations/x"},
                token=b"a" * 30,
                project=project,
                deadline=MODULE.time.monotonic() + 1,
            )

    def test_bootstrap_job_execution_requires_completed_single_success(self):
        prefix = "projects/axiom-proof/locations/asia-south1/jobs/axiom-proof-preprod-migrations-roles"
        execution = prefix + "/executions/axiom-proof-preprod-migrations-roles-123"
        descriptor = {
            "project": "axiom-proof",
            "region": "asia-south1",
            "release_sha": SHA,
            "phase": "roles",
            "database_connection_name": "axiom-proof:asia-south1:axiom-proof-preprod-postgres",
            "job": {"name": prefix, "template": {}},
        }
        responses = [
            {"name": "projects/axiom-proof/locations/asia-south1/operations/create"},
            {
                "name": "projects/axiom-proof/locations/asia-south1/operations/create",
                "done": True,
                "response": {"name": prefix},
            },
            {"name": "projects/axiom-proof/locations/asia-south1/operations/run"},
            {
                "name": "projects/axiom-proof/locations/asia-south1/operations/run",
                "done": True,
                "response": {"name": execution},
            },
            {
                "name": execution,
                "completionTime": "2026-10-09T00:00:00Z",
                "taskCount": 1,
                "succeededCount": 1,
            },
        ]
        with (
            patch.object(MODULE, "run_command", return_value=b"a" * 30),
            patch.object(MODULE, "run_job_api", side_effect=responses) as api,
        ):
            MODULE.execute_bootstrap_job(descriptor, work=self.evidence_root)
        self.assertIn("?jobId=", api.call_args_list[0].args[1])
        self.assertEqual(api.call_args_list[2].args[1], prefix + ":run")
        self.assertEqual(api.call_args_list[4].args[1], execution)
        self.assertEqual(
            MODULE.protected_json(
                self.evidence_root / "bootstrap-roles.receipt.private.json"
            )["execution"],
            execution,
        )
        (self.evidence_root / "bootstrap-roles.receipt.private.json").unlink()
        responses[-1] = {**responses[-1], "succeededCount": 0, "failedCount": 1}
        with (
            patch.object(MODULE, "run_command", return_value=b"a" * 30),
            patch.object(MODULE, "run_job_api", side_effect=responses),
            self.assertRaises(ValueError),
        ):
            MODULE.execute_bootstrap_job(descriptor, work=self.evidence_root)
        self.assertFalse(
            (self.evidence_root / "bootstrap-roles.receipt.private.json").exists()
        )

    def test_service_plan_rejects_wrong_scope_destructive_action_and_missing_seed(self):
        values = {
            "project_id": "axiom-proof",
            "release_sha": SHA,
            "images": self.release["images"],
            "service_secrets": {},
            "lifecycle_seed_generation": "7",
            "lifecycle_seed_target_sha256": PIN,
        }
        variables = {
            key: {"value": value}
            for key, value in {
                "project_id": "axiom-proof",
                "environment": "preprod",
                "region": "asia-south1",
                "release_sha": SHA,
                "deploy_services": True,
                "images": values["images"],
                "service_secrets": {},
                "lifecycle_scheduler_paused": True,
                "auth_bootstrap_only": False,
                "lifecycle_state_initialized": True,
                "lifecycle_seed_generation": "7",
                "lifecycle_seed_target_sha256": PIN,
            }.items()
        }
        change = {
            "address": "module.auth[0].google_cloud_run_v2_service.request[0]",
            "module_address": "module.auth[0]",
            "mode": "managed",
            "change": {
                "actions": ["create"],
                "after": {"project": "axiom-proof", "location": "asia-south1"},
            },
        }
        document = {
            "format_version": "1.2",
            "variables": variables,
            "resource_changes": [change],
        }
        variables["auth_bootstrap_only"]["value"] = True
        self.assertEqual(
            MODULE.inspect_service_plan(
                document, values=values, phase="bootstrap-auth"
            )["create"],
            1,
        )
        variables["auth_bootstrap_only"]["value"] = False
        self.assertEqual(
            MODULE.inspect_service_plan(document, values=values, phase="services")[
                "create"
            ],
            1,
        )
        variables["auth_bootstrap_only"]["value"] = True
        for altered in (
            {**change, "change": {"actions": ["delete"]}},
            {**change, "module_address": "module.rest[0]"},
            {
                **change,
                "address": "module.rest[0].google_cloud_run_v2_service.request[0]",
                "module_address": "module.rest[0]",
            },
        ):
            with self.assertRaises(ValueError):
                MODULE.inspect_service_plan(
                    {**document, "resource_changes": [altered]},
                    values=values,
                    phase="bootstrap-auth",
                )
        variables["auth_bootstrap_only"]["value"] = False
        with self.assertRaises(ValueError):
            MODULE.inspect_service_plan(
                {
                    **document,
                    "variables": {
                        **variables,
                        "lifecycle_state_initialized": {"value": False},
                    },
                },
                values=values,
                phase="services",
            )

    def test_service_values_refuse_missing_or_mismatched_seed_receipt(self):
        versions = {
            self.env[key]: "7"
            for key in (
                "MARKETING_AUTH_DB_URL_SECRET",
                "MARKETING_REST_DB_URL_SECRET",
                "MARKETING_JWT_SECRET",
                "MARKETING_SERVICE_KEY_SECRET",
            )
        }
        with self.assertRaises(ValueError):
            MODULE.service_values(
                phase="services",
                env=self.env,
                release=self.release,
                versions=versions,
            )
        with self.assertRaises(ValueError):
            MODULE.service_values(
                phase="services",
                env=self.env,
                release=self.release,
                versions=versions,
                seed_receipt={"state_initialized": True, "seed_generation": "7"},
            )

    def test_full_services_verify_live_generation_pinned_seed_bytes(self):
        selected = {
            "environment": "preprod",
            "project": "axiom-proof",
            "instance": self.env["CLOUD_SQL_INSTANCE_NAME"],
            "bucket": self.env["AXIOM_IDLE_STATE_BUCKET"],
            "object": self.env["AXIOM_IDLE_STATE_OBJECT"],
        }
        manifest = (
            json.dumps(selected, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode()
        digest = hashlib.sha256(manifest).hexdigest()
        release = {**self.release, "lifecycle_target_manifest_sha256": digest}
        body = json.dumps(
            {
                "version": 1,
                "targetHash": digest,
                "phase": "running",
                "leases": {},
                "lastActivity": 1_800_000_000,
            }
        ).encode()
        receipt = {
            "release_sha": SHA,
            "project": "axiom-proof",
            "bucket": selected["bucket"],
            "object": selected["object"],
            "seed_target_sha256": digest,
            "seed_generation": "7",
            "seed_body_sha256": hashlib.sha256(body).hexdigest(),
        }
        metadata = json.dumps(
            {
                "bucket": selected["bucket"],
                "name": selected["object"],
                "generation": "7",
            }
        ).encode()

        class Response:
            def __init__(self, raw):
                self.raw = raw

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return None

            def read(self, *_):
                return self.raw

        with (
            patch.object(MODULE, "run_command", return_value=b"a" * 30),
            patch.object(
                MODULE, "urlopen", side_effect=[Response(metadata), Response(body)]
            ) as calls,
        ):
            MODULE.verify_seed_receipt(self.env, release, receipt)
        self.assertIn("generation=7", calls.call_args_list[1].args[0].full_url)
        with (
            patch.object(MODULE, "run_command", return_value=b"a" * 30),
            patch.object(
                MODULE,
                "urlopen",
                side_effect=[Response(metadata), Response(body + b"changed")],
            ),
            self.assertRaises(ValueError),
        ):
            MODULE.verify_seed_receipt(self.env, release, receipt)

    def test_targeted_auth_terraform_applies_reviewed_binary_and_ready_service(self):
        values = {
            "project_id": "axiom-proof",
            "release_sha": SHA,
            "images": self.release["images"],
            "service_secrets": {},
            "lifecycle_scheduler_paused": True,
            "auth_bootstrap_only": True,
            "service_names": {"auth": self.env["MARKETING_AUTH_SERVICE_NAME"]},
            "cloud_sql_instance_name": self.env["CLOUD_SQL_INSTANCE_NAME"],
        }
        variables = {
            key: {"value": value}
            for key, value in {
                "project_id": "axiom-proof",
                "environment": "preprod",
                "region": "asia-south1",
                "release_sha": SHA,
                "deploy_services": True,
                "images": values["images"],
                "service_secrets": {},
                "lifecycle_scheduler_paused": True,
                "auth_bootstrap_only": True,
            }.items()
        }
        document = {
            "format_version": "1.2",
            "variables": variables,
            "resource_changes": [
                {
                    "address": "module.auth[0].google_cloud_run_v2_service.request",
                    "module_address": "module.auth[0]",
                    "mode": "managed",
                    "change": {
                        "actions": ["create"],
                        "after": {"project": "axiom-proof", "location": "asia-south1"},
                    },
                }
            ],
        }
        commands = []

        def fake(argv, **_):
            commands.append(argv)
            if "workspace" in argv:
                return b"default\n"
            if "plan" in argv:
                (self.evidence_root / "bootstrap-auth.tfplan").write_bytes(
                    b"reviewed-auth-plan"
                )
            if "show" in argv:
                return json.dumps(document).encode()
            if "describe" in argv:
                return json.dumps(
                    {
                        "name": f"projects/axiom-proof/locations/asia-south1/services/{values['service_names']['auth']}",
                        "terminalCondition": {"state": "CONDITION_SUCCEEDED"},
                        "reconciling": False,
                        "generation": "2",
                        "observedGeneration": "2",
                        "latestReadyRevision": "auth-00002",
                        "latestCreatedRevision": "auth-00002",
                    }
                ).encode()
            return b""

        with patch.object(MODULE, "run_command", side_effect=fake):
            MODULE.service_terraform(
                phase="bootstrap-auth",
                planning=True,
                work=self.evidence_root,
                env=self.env,
                values=values,
                approval=None,
            )
            self.assertTrue(any("-target=module.auth[0]" in argv for argv in commands))
            approved = approval(
                hashlib.sha256(
                    (self.evidence_root / "bootstrap-auth.tfplan").read_bytes()
                ).hexdigest()
            )
            approved["allowed_phases"] = ["bootstrap-auth"]
            MODULE.service_terraform(
                phase="bootstrap-auth",
                planning=False,
                work=self.evidence_root,
                env=self.env,
                values=values,
                approval=approved,
            )
        self.assertTrue(any("apply" in argv for argv in commands))
        self.assertTrue(
            MODULE.protected_json(
                self.evidence_root / "bootstrap-auth.receipt.private.json"
            )["service_ready"]
        )

    def test_exact_clean_source_environment_release_and_clearance_required(self):
        values = MODULE.validate_inputs(self.env, self.release, self.clearance, SHA)
        self.assertEqual(values["project_id"], "axiom-proof")
        self.assertFalse(values["deploy_services"])
        changes = [
            ("ENVIRONMENT", "production"),
            ("GCP_REGION", "us-central1"),
            ("AXIOM_DEPLOYMENT_PROFILE", "full"),
            ("GCP_PROJECT_ID", "foreign-project"),
            ("AXIOM_TF_STATE_BUCKET", "foreign-state-bucket"),
            ("AXIOM_MARKETING_TF_STATE_PREFIX", "terraform/state/preprod"),
        ]
        for key, value in changes:
            with self.subTest(key=key), self.assertRaises(ValueError):
                MODULE.validate_inputs(
                    {**self.env, key: value}, self.release, self.clearance, SHA
                )
        with self.assertRaises(ValueError):
            MODULE.validate_inputs(self.env, self.release, self.clearance, "c" * 40)

    def test_mutable_foreign_or_uncleared_image_refused(self):
        for bad in (
            "asia-south1-docker.pkg.dev/axiom-proof/repo/bff:latest",
            f"asia-south1-docker.pkg.dev/foreign-project/repo/bff@sha256:{PIN}",
        ):
            with self.subTest(bad=bad):
                release = json.loads(json.dumps(self.release))
                release["images"]["bff"] = bad
                with self.assertRaises(ValueError):
                    MODULE.validate_inputs(self.env, release, self.clearance, SHA)
        clearance = json.loads(json.dumps(self.clearance))
        clearance["checks"][0]["status"] = "pending"
        with self.assertRaises(ValueError):
            MODULE.validate_inputs(self.env, self.release, clearance, SHA)

    def test_clearance_requires_actual_protected_evidence_bytes_and_source_binding(
        self,
    ):
        MODULE.validate_inputs(self.env, self.release, self.clearance, SHA)
        first = self.clearance["checks"][0]
        path = Path(first["evidence_path"])
        original = path.read_bytes()
        path.write_bytes(original + b"tampered")
        with self.assertRaises(ValueError):
            MODULE.validate_inputs(self.env, self.release, self.clearance, SHA)
        path.write_bytes(original)
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            MODULE.validate_inputs(self.env, self.release, self.clearance, SHA)
        path.chmod(0o600)
        alias = self.evidence_root / "alias.json"
        alias.symlink_to(path)
        first["evidence_path"] = str(alias)
        with self.assertRaises(ValueError):
            MODULE.validate_inputs(self.env, self.release, self.clearance, SHA)
        first["evidence_path"] = str(path)
        with tempfile.NamedTemporaryFile() as foreign:
            first["evidence_path"] = foreign.name
            with self.assertRaises(ValueError):
                MODULE.validate_inputs(self.env, self.release, self.clearance, SHA)
        first["evidence_path"] = str(path)
        wrong = json.loads(original)
        wrong["release_sha"] = "c" * 40
        changed = json.dumps(wrong).encode()
        path.write_bytes(changed)
        first["evidence_sha256"] = hashlib.sha256(changed).hexdigest()
        with self.assertRaises(ValueError):
            MODULE.validate_inputs(self.env, self.release, self.clearance, SHA)
        clearance = json.loads(json.dumps(self.clearance))
        clearance["images"]["bff"] = (
            f"asia-south1-docker.pkg.dev/axiom-proof/repo/bff@sha256:{'c' * 64}"
        )
        with self.assertRaises(ValueError):
            MODULE.validate_inputs(self.env, self.release, clearance, SHA)
        clearance = json.loads(json.dumps(self.clearance))
        clearance["images"]["migrations"] = (
            f"asia-south1-docker.pkg.dev/axiom-proof/repo/migration@sha256:{'c' * 64}"
        )
        with self.assertRaises(ValueError):
            MODULE.validate_inputs(self.env, self.release, clearance, SHA)

    def test_protected_inputs_refuse_example_symlink_and_broad_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            selected = root / "selected.json"
            selected.write_text("{}")
            selected.chmod(0o600)
            self.assertEqual(MODULE.protected_json(selected), {})
            selected.chmod(0o644)
            with self.assertRaises(ValueError):
                MODULE.protected_json(selected)
            selected.chmod(0o600)
            alias = root / "alias.json"
            alias.symlink_to(selected)
            with self.assertRaises(ValueError):
                MODULE.protected_json(alias)
            example = root / "selected.env.example"
            example.write_text("GCP_PROJECT_ID=axiom-proof\n")
            with self.assertRaises(ValueError):
                MODULE.protected_env(example)

    def test_clean_revision_refuses_dirty_checkout(self):
        def fake(argv, **kwargs):
            value = SHA if argv[1] == "rev-parse" else " M sensitive-file\n"
            return subprocess.CompletedProcess(argv, 0, value, "")

        with (
            patch.object(MODULE.subprocess, "run", side_effect=fake),
            self.assertRaises(ValueError),
        ):
            MODULE.clean_revision(ROOT)

    def test_plan_inspection_rejects_deletes_replacements_updates_and_foreign_scope(
        self,
    ):
        accepted = MODULE.inspect_base_plan(
            plan(
                ("google_sql_database_instance.marketing", ["create"]),
                ('google_project_service.apis["run.googleapis.com"]', ["no-op"]),
            ),
            project="axiom-proof",
        )
        self.assertEqual(accepted, {"create": 1, "no-op": 1})
        for item in (
            plan(("google_sql_database_instance.marketing", ["delete"])),
            plan(("google_sql_database_instance.marketing", ["delete", "create"])),
            plan(("google_sql_database_instance.marketing", ["update"])),
            plan(("module.foreign.google_sql_database_instance.marketing", ["create"])),
            plan(("google_cloud_run_v2_service.lifecycle", ["create"])),
            plan(("google_sql_database_instance.marketing", ["create"])),
        ):
            if item["resource_changes"][0][
                "address"
            ] == "google_sql_database_instance.marketing" and item["resource_changes"][
                0
            ]["change"]["actions"] == ["create"]:
                item["resource_changes"][0]["change"]["after"]["project"] = (
                    "foreign-project"
                )
            with self.subTest(item=item), self.assertRaises(ValueError):
                MODULE.inspect_base_plan(item, project="axiom-proof")

    def test_plan_variables_must_bind_exact_release_and_base_phase(self):
        document = plan(("google_sql_database_instance.marketing", ["create"]))
        MODULE.inspect_base_plan(document, project="axiom-proof", release_sha=SHA)
        for key, value in (
            ("project_id", "foreign-project"),
            ("region", "us-central1"),
            ("release_sha", "c" * 40),
            ("deploy_services", True),
        ):
            with self.subTest(key=key):
                changed = json.loads(json.dumps(document))
                changed["variables"][key]["value"] = value
                with self.assertRaises(ValueError):
                    MODULE.inspect_base_plan(
                        changed, project="axiom-proof", release_sha=SHA
                    )

    def test_approval_binds_exact_plan_human_source_and_rollback(self):
        record = approval(PIN)
        MODULE.validate_approval(
            record, env=self.env, source_sha=SHA, plan_sha=PIN, phase="base"
        )
        for mutation in (
            {"source": "automation"},
            {"dry_run_plan_sha256": "c" * 64},
            {"allowed_phases": ["plan"]},
            {
                "rollback": {
                    "preserve_database": False,
                    "prevent_publication": True,
                    "production": False,
                }
            },
        ):
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                MODULE.validate_approval(
                    {**record, **mutation},
                    env=self.env,
                    source_sha=SHA,
                    plan_sha=PIN,
                    phase="base",
                )

    def test_prepare_writes_private_file_without_cloud_calls(self):
        values = MODULE.validate_inputs(self.env, self.release, self.clearance, SHA)
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(MODULE, "run_command") as run,
        ):
            work = Path(directory)
            MODULE.terraform("prepare", work=work, env=self.env, values=values)
            self.assertEqual(
                json.loads((work / "base.auto.tfvars.json").read_text())["project_id"],
                "axiom-proof",
            )
            self.assertEqual(
                stat.S_IMODE((work / "base.auto.tfvars.json").stat().st_mode), 0o600
            )
            run.assert_not_called()

    def test_plan_uses_selected_backend_and_refuses_existing_artifacts(self):
        values = MODULE.validate_inputs(self.env, self.release, self.clearance, SHA)
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            commands = []

            def fake(argv, **kwargs):
                commands.append(argv)
                if "workspace" in argv:
                    return b"default\n"
                if "plan" in argv:
                    (work / "base.tfplan").write_bytes(b"synthetic-private-plan")
                if "show" in argv:
                    return json.dumps(
                        plan(("google_sql_database_instance.marketing", ["create"]))
                    ).encode()
                return b""

            with patch.object(MODULE, "run_command", side_effect=fake):
                MODULE.terraform("plan", work=work, env=self.env, values=values)
            init = next(argv for argv in commands if "init" in argv)
            self.assertIn(
                "-backend-config=bucket=" + self.env["AXIOM_TF_STATE_BUCKET"], init
            )
            self.assertIn(
                "-backend-config=prefix=terraform/state/marketing-preprod", init
            )
            self.assertEqual(stat.S_IMODE((work / "base.tfplan").stat().st_mode), 0o600)
            meta = MODULE.protected_json(work / "base.plan.private.json")
            self.assertEqual(meta["summary"], {"create": 1, "no-op": 0})
            with (
                patch.object(MODULE, "run_command") as run,
                self.assertRaises(ValueError),
            ):
                MODULE.terraform("plan", work=work, env=self.env, values=values)
            run.assert_not_called()

    def test_base_refuses_unapproved_or_changed_plan_before_apply(self):
        values = MODULE.validate_inputs(self.env, self.release, self.clearance, SHA)
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            binary = work / "base.tfplan"
            binary.write_bytes(b"synthetic-private-plan")
            binary.chmod(0o600)
            digest = hashlib.sha256(binary.read_bytes()).hexdigest()
            MODULE.protected_output(
                work / "base.plan.private.json",
                {
                    "release_sha": SHA,
                    "project": "axiom-proof",
                    "plan_sha256": digest,
                    "summary": {"create": 1, "no-op": 0},
                },
            )
            shown = json.dumps(
                plan(("google_sql_database_instance.marketing", ["delete"]))
            ).encode()
            with (
                patch.object(MODULE, "run_command", return_value=shown) as run,
                self.assertRaises(ValueError),
            ):
                MODULE.apply_base(
                    work=work, env=self.env, values=values, approval=approval(digest)
                )
            self.assertFalse(
                any("apply" in call.args[0] for call in run.call_args_list)
            )
            binary.write_bytes(b"tampered")
            with (
                patch.object(MODULE, "run_command") as run,
                self.assertRaises(ValueError),
            ):
                MODULE.apply_base(
                    work=work, env=self.env, values=values, approval=approval(digest)
                )
            run.assert_not_called()

    def test_base_applies_only_approved_plan_and_records_exact_private_database_output(
        self,
    ):
        values = MODULE.validate_inputs(self.env, self.release, self.clearance, SHA)
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            binary = work / "base.tfplan"
            binary.write_bytes(b"synthetic-private-plan")
            binary.chmod(0o600)
            digest = hashlib.sha256(binary.read_bytes()).hexdigest()
            MODULE.protected_output(
                work / "base.plan.private.json",
                {
                    "release_sha": SHA,
                    "project": "axiom-proof",
                    "plan_sha256": digest,
                    "summary": {"create": 1, "no-op": 0},
                },
            )
            database = {
                "instance": values["cloud_sql_instance_name"],
                "name": values["cloud_sql_database_name"],
                "connection_name": f"axiom-proof:asia-south1:{values['cloud_sql_instance_name']}",
                "private_ip": "10.73.1.4",
            }
            commands = []

            def fake(argv, **kwargs):
                commands.append(argv)
                if "workspace" in argv:
                    return b"default\n"
                if "show" in argv:
                    return json.dumps(
                        plan(("google_sql_database_instance.marketing", ["create"]))
                    ).encode()
                if "output" in argv:
                    return json.dumps(
                        {
                            "database": {"value": database},
                            "migration_service_account": {
                                "value": f"{self.env['MARKETING_MIGRATION_ACCOUNT_ID']}@axiom-proof.iam.gserviceaccount.com"
                            },
                        }
                    ).encode()
                return b""

            with patch.object(MODULE, "run_command", side_effect=fake):
                MODULE.apply_base(
                    work=work, env=self.env, values=values, approval=approval(digest)
                )
            self.assertLess(
                next(i for i, argv in enumerate(commands) if "show" in argv),
                next(i for i, argv in enumerate(commands) if "apply" in argv),
            )
            self.assertLess(
                next(i for i, argv in enumerate(commands) if "init" in argv),
                next(i for i, argv in enumerate(commands) if "apply" in argv),
            )
            self.assertEqual(
                MODULE.protected_json(work / "database.private.json"), database
            )
            self.assertEqual(
                stat.S_IMODE((work / "database.private.json").stat().st_mode), 0o600
            )

    def test_terraform_subprocess_scrubs_ambient_cli_overrides_and_never_prints_output(
        self,
    ):
        observed = []

        def fake(argv, **kwargs):
            observed.append(kwargs["env"])
            return subprocess.CompletedProcess(argv, 0, b"secret-output", b"")

        with (
            patch.dict(
                os.environ,
                {
                    "TF_CLI_ARGS": "-destroy",
                    "TF_WORKSPACE": "production",
                    "TF_VAR_project_id": "foreign",
                },
            ),
            patch.object(MODULE.subprocess, "run", side_effect=fake),
        ):
            self.assertEqual(
                MODULE.run_command(["terraform", "version"], cwd=ROOT), b""
            )
        self.assertNotIn("TF_CLI_ARGS", observed[0])
        self.assertNotIn("TF_WORKSPACE", observed[0])
        self.assertNotIn("TF_VAR_project_id", observed[0])
        self.assertEqual(observed[0]["TF_INPUT"], "0")

    def test_cli_dry_run_never_creates_workdir_or_calls_cloud_tools(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env_file, release_file, clearance_file = (
                root / name
                for name in ("selected.env", "release.json", "clearance.json")
            )
            env_file.write_text(
                "".join(f"{key}={value}\n" for key, value in self.env.items())
            )
            release_file.write_text(json.dumps(self.release))
            clearance_file.write_text(json.dumps(self.clearance))
            for path in (env_file, release_file, clearance_file):
                path.chmod(0o600)
            work = root / "never-created"
            argv = [
                "deploy",
                "--phase",
                "plan",
                "--env-file",
                str(env_file),
                "--release-manifest",
                str(release_file),
                "--security-clearance",
                str(clearance_file),
                "--work-dir",
                str(work),
                "--dry-run",
            ]
            output = io.StringIO()
            with (
                patch.object(sys, "argv", argv),
                patch.object(MODULE, "clean_revision", return_value=SHA),
                patch.object(MODULE, "run_command") as run,
                redirect_stdout(output),
            ):
                self.assertEqual(MODULE.main(), 0)
            run.assert_not_called()
            self.assertFalse(work.exists())
            self.assertIn("no Terraform plan or cloud changes", output.getvalue())

    def test_unimplemented_later_phase_refuses_before_any_cloud_call(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory) / "work"
            argv = [
                "deploy",
                "--phase",
                "acceptance",
                "--env-file",
                "missing",
                "--release-manifest",
                "missing",
                "--security-clearance",
                "missing",
                "--work-dir",
                str(work),
                "--dry-run",
            ]
            with (
                patch.object(sys, "argv", argv),
                patch.object(MODULE, "clean_revision") as git,
                patch.object(MODULE, "run_command") as run,
                redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(MODULE.main(), 1)
            git.assert_not_called()
            run.assert_not_called()
            self.assertFalse(work.exists())


class FencedCoordinatorTests(unittest.TestCase):
    """Real helper compatibility, mocked cloud transport; no cloud mutation."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.work = Path(directory.name)
        self.work.chmod(0o700)
        self.env, self.release, _ = inputs(self.work)
        self.database = {
            "connection_name": f"axiom-proof:asia-south1:{self.env['CLOUD_SQL_INSTANCE_NAME']}",
            "name": self.env["CLOUD_SQL_DATABASE_NAME"],
            "instance": self.env["CLOUD_SQL_INSTANCE_NAME"],
            "private_ip": "10.73.1.2",
        }
        self.identity = {
            "project": "axiom-proof",
            "release_sha": SHA,
            "email": f"{self.env['MARKETING_MIGRATION_ACCOUNT_ID']}@axiom-proof.iam.gserviceaccount.com",
        }
        target = {
            "environment": "preprod",
            "project": "axiom-proof",
            "instance": self.env["CLOUD_SQL_INSTANCE_NAME"],
            "bucket": self.env["AXIOM_IDLE_STATE_BUCKET"],
            "object": self.env["AXIOM_IDLE_STATE_OBJECT"],
        }
        self.release["lifecycle_target_manifest_sha256"] = hashlib.sha256(
            self.canonical(target)
        ).hexdigest()
        self.receipts = {}
        for phase in ("roles", "series", "auth"):
            receipt = {
                "project": "axiom-proof",
                "release_sha": SHA,
                "database_connection_name": self.database["connection_name"],
            }
            if phase == "auth":
                receipt.update(
                    service=self.env["MARKETING_AUTH_SERVICE_NAME"], service_ready=True
                )
            else:
                name = f"projects/axiom-proof/locations/asia-south1/jobs/{self.env['MARKETING_MIGRATION_JOB_NAME']}-{phase}"
                receipt.update(
                    phase=phase,
                    job=name,
                    execution=name + "/executions/receipt-123",
                    descriptor_sha256=PIN,
                    completion_time="2026-10-10T00:00:00Z",
                )
            self.receipts[phase] = receipt
            self.write(self.work / f"bootstrap-{phase}.receipt.private.json", receipt)
        self.binding = MODULE.fenced_seed_binding(
            self.env, self.release, self.database, self.work, 1_791_590_000
        )
        self.versions = {
            self.env[key]: "7"
            for key in (
                "MARKETING_ADMIN_DB_URL_SECRET",
                "MARKETING_AUTH_PASSWORD_SECRET",
                "MARKETING_REST_PASSWORD_SECRET",
            )
        }
        self.descriptor = MODULE.bootstrap_job_descriptor(
            phase="adopt",
            env=self.env,
            release=self.release,
            database=self.database,
            versions=self.versions,
            migration_identity=self.identity,
            adoption_binding=self.binding,
        )

    @staticmethod
    def canonical(value):
        return (
            json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode()

    def write(self, path, value):
        path.write_bytes(self.canonical(value))
        path.chmod(0o600)

    def provider_fixture(self):
        body = self.canonical(
            {
                "version": 1,
                "targetHash": self.binding["target_manifest_sha256"],
                "phase": "running",
                "lastActivity": self.binding["seed_created_unix"],
                "leases": {},
                "transition": None,
                "operation": None,
            }
        )
        receipt = {
            "release_sha": SHA,
            "project": "axiom-proof",
            "database_connection_name": self.database["connection_name"],
            "bucket": self.env["AXIOM_IDLE_STATE_BUCKET"],
            "object": self.env["AXIOM_IDLE_STATE_OBJECT"],
            "seed_target_sha256": self.binding["target_manifest_sha256"],
            "seed_body_sha256": hashlib.sha256(body).hexdigest(),
            "state_initialized": True,
            "exclusive_client_adoption": True,
            "admission_reopened": True,
            "admission_protocol": "pg15-startup-lock-then-visible-clients",
            "admission_source_sha256": hashlib.sha256(
                (ROOT / "scripts/marketing-state-adoption.py").read_bytes()
            ).hexdigest(),
            "admission_sql_sha256": hashlib.sha256(
                self.canonical(
                    MODULE.job_module.admission_programs(self.database["name"])
                )
            ).hexdigest(),
            "bootstrap_receipts_sha256": hashlib.sha256(
                self.canonical(self.receipts)
            ).hexdigest(),
            "seed_generation": "7",
            "native_pid": 123,
        }
        job_name = self.descriptor["job"]["name"].rsplit("/", 1)[1]
        execution = {
            "execution": self.descriptor["job"]["name"] + "/executions/adopt-123",
            "project": "axiom-proof",
            "release_sha": SHA,
            "phase": "adopt",
            "job": self.descriptor["job"]["name"],
            "database_connection_name": self.database["connection_name"],
            "descriptor_sha256": hashlib.sha256(
                self.canonical(self.descriptor)
            ).hexdigest(),
            "completion_time": "2026-10-10T00:00:30Z",
        }
        entry = {
            "resource": {
                "type": "cloud_run_job",
                "labels": {
                    "job_name": job_name,
                    "location": "asia-south1",
                    "project_id": "axiom-proof",
                },
            },
            "labels": {"run.googleapis.com/execution_name": "adopt-123"},
            "timestamp": "2026-10-10T00:00:15Z",
            "jsonPayload": {"marketing_seed_receipt": receipt},
        }
        metadata = {
            "bucket": receipt["bucket"],
            "name": receipt["object"],
            "generation": "7",
        }
        return receipt, execution, entry, metadata, body

    def read_receipt(self, execution, entry, metadata, body, actual_changes=None):
        class Response:
            def __init__(self, raw):
                self.raw = raw

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return None

            def read(self, *_):
                return self.raw

        actual = {
            "name": execution["execution"],
            "startTime": "2026-10-10T00:00:00Z",
            "completionTime": "2026-10-10T00:00:30Z",
            "taskCount": 1,
            "succeededCount": 1,
            "failedCount": 0,
            "cancelledCount": 0,
        }
        actual.update(actual_changes or {})
        with (
            patch.object(MODULE, "run_job_api", return_value=actual),
            patch.object(
                MODULE,
                "run_command",
                side_effect=[b"a" * 30, json.dumps([entry]).encode()],
            ),
            patch.object(
                MODULE,
                "urlopen",
                side_effect=[Response(json.dumps(metadata).encode()), Response(body)],
            ) as transport,
        ):
            result = MODULE.read_fenced_seed_receipt(
                self.descriptor,
                execution,
                work=self.work,
                env=self.env,
                release=self.release,
            )
        self.assertTrue(
            all(
                "generation=7" in call.args[0].full_url
                for call in transport.call_args_list
            )
        )
        return result

    def test_fenced_binding_consumed_by_actual_frozen_admission_helper(self):
        env = {
            row["name"]: row["value"]
            for row in self.descriptor["job"]["template"]["template"]["containers"][0][
                "env"
            ]
            if "value" in row
        }
        spec = importlib.util.spec_from_file_location(
            "frozen_admission_contract", ROOT / "scripts/marketing-state-adoption.py"
        )
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        self.assertEqual(helper.admission_binding(env, self.binding), self.binding)
        self.assertGreater(self.binding["drain_seconds"], 0)

    def test_bootstrap_receipt_source_mismatch_refuses_seed_binding(self):
        for phase in self.receipts:
            with self.subTest(phase=phase):
                original = self.receipts[phase]
                self.write(
                    self.work / f"bootstrap-{phase}.receipt.private.json",
                    {**original, "release_sha": "c" * 40},
                )
                with self.assertRaises(ValueError):
                    MODULE.fenced_seed_binding(
                        self.env,
                        self.release,
                        self.database,
                        self.work,
                        self.binding["seed_created_unix"],
                    )
                self.write(
                    self.work / f"bootstrap-{phase}.receipt.private.json", original
                )

    def test_actual_admission_receipt_exact_source_sql_and_generation(self):
        receipt, execution, entry, metadata, body = self.provider_fixture()
        result = self.read_receipt(execution, entry, metadata, body)
        self.assertEqual(
            result["admission_sql_sha256"], receipt["admission_sql_sha256"]
        )
        self.assertEqual(result["job_execution"], execution["execution"])

    def test_changed_admission_source_sql_or_boolean_refused(self):
        for key, value in (
            ("admission_source_sha256", "0" * 64),
            ("admission_sql_sha256", "0" * 64),
            ("state_initialized", 1),
            ("admission_reopened", 1),
            ("exclusive_client_adoption", 1),
            ("seed_generation", "0"),
            ("native_pid", True),
        ):
            with self.subTest(key=key):
                _, execution, entry, metadata, body = self.provider_fixture()
                entry["jsonPayload"]["marketing_seed_receipt"][key] = value
                with self.assertRaises(ValueError):
                    self.read_receipt(execution, entry, metadata, body)

    def test_independent_seed_bytes_and_generation_refusal(self):
        _, execution, entry, metadata, body = self.provider_fixture()
        with self.assertRaises(ValueError):
            self.read_receipt(execution, entry, {**metadata, "generation": "8"}, body)
        with self.assertRaises(ValueError):
            self.read_receipt(execution, entry, metadata, body + b"changed")

    def test_foreign_execution_log_refused(self):
        _, execution, entry, metadata, body = self.provider_fixture()
        entry["labels"]["run.googleapis.com/execution_name"] = "foreign-123"
        with self.assertRaises(ValueError):
            self.read_receipt(execution, entry, metadata, body)

    def test_seed_execution_refuses_changed_plan_before_cloud(self):
        plan = {
            **self.descriptor,
            "seed_created_unix": self.binding["seed_created_unix"],
            "project": "foreign",
        }
        self.write(self.work / "seed.plan.private.json", plan)
        approved = approval(
            hashlib.sha256(
                (self.work / "seed.plan.private.json").read_bytes()
            ).hexdigest()
        )
        approved["allowed_phases"] = ["seed"]
        with (
            patch.object(
                MODULE,
                "execute_bootstrap_job",
                side_effect=AssertionError("Changed plan reached execution"),
            ) as execute,
            self.assertRaises(ValueError),
        ):
            MODULE.fenced_seed_phase(
                planning=False,
                work=self.work,
                env=self.env,
                release=self.release,
                database=self.database,
                versions=self.versions,
                migration_identity=self.identity,
                approval=approved,
            )
        execute.assert_not_called()

    def test_hosting_dry_run_and_plan_routing_never_publish(self):
        for phase in ("hosting-plan", "hosting", "browser-acceptance"):
            helper = SimpleNamespace(
                inputs=MagicMock(return_value=(self.env, self.release, {}, {})),
                prepare_hosting_export=MagicMock(),
                publish_hosting_export=MagicMock(),
                run_browser_acceptance=MagicMock(),
            )
            fake_spec = SimpleNamespace(
                loader=SimpleNamespace(exec_module=lambda _: None)
            )
            with (
                patch.object(
                    MODULE.importlib.util,
                    "spec_from_file_location",
                    return_value=fake_spec,
                ),
                patch.object(
                    MODULE.importlib.util, "module_from_spec", return_value=helper
                ),
                patch.object(MODULE, "run_command") as run,
            ):
                MODULE.hosting_phase(
                    phase=phase,
                    env_file=self.work / "env",
                    release_file=self.work / "release",
                    work=self.work,
                    approval_file=self.work / "approval",
                    dry_run=True,
                )
            run.assert_not_called()
            helper.prepare_hosting_export.assert_not_called()
            helper.publish_hosting_export.assert_not_called()
            helper.run_browser_acceptance.assert_not_called()

    def test_readback_bad_numeric_secret_refuses_before_prepare_or_cloud(self):
        self.write(self.work / "database.private.json", self.database)
        self.write(self.work / "migration-identity.private.json", self.identity)
        helper = SimpleNamespace(prepare_readback_job=MagicMock())
        fake_spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda _: None))
        with (
            patch.object(
                MODULE.importlib.util, "spec_from_file_location", return_value=fake_spec
            ),
            patch.object(
                MODULE.importlib.util, "module_from_spec", return_value=helper
            ),
            patch.object(MODULE, "execute_bootstrap_job") as run,
            self.assertRaises(ValueError),
        ):
            MODULE.readback_phase(
                planning=True,
                env_file=self.work / "env",
                env=self.env,
                release=self.release,
                work=self.work,
                versions={self.env["MARKETING_ADMIN_DB_URL_SECRET"]: "latest"},
                approval=None,
            )
        run.assert_not_called()
        helper.prepare_readback_job.assert_not_called()

    def test_execution_receipt_bound_before_any_provider_read(self):
        for key, value in (
            ("descriptor_sha256", "0" * 64),
            ("project", "foreign"),
            ("release_sha", "c" * 40),
            ("job", "foreign"),
            ("phase", "roles"),
            ("database_connection_name", "foreign"),
            ("execution", "foreign/executions/adopt-123"),
        ):
            with self.subTest(key=key):
                _, execution, _entry, _metadata, _body = self.provider_fixture()
                execution[key] = value
                with (
                    patch.object(MODULE, "run_command") as command,
                    self.assertRaises(ValueError),
                ):
                    MODULE.read_fenced_seed_receipt(
                        self.descriptor,
                        execution,
                        work=self.work,
                        env=self.env,
                        release=self.release,
                    )
                command.assert_not_called()

    def test_actual_execution_failure_and_stale_timestamp_refused(self):
        for changes in (
            {"failedCount": 1},
            {"succeededCount": 0},
            {"completionTime": "2026-10-10T00:00:31Z"},
            {"name": "foreign"},
            {"startTime": "2026-10-10T00:00:31Z"},
        ):
            with self.subTest(changes=changes):
                _, execution, entry, metadata, body = self.provider_fixture()
                with self.assertRaises(ValueError):
                    self.read_receipt(execution, entry, metadata, body, changes)
        _, execution, entry, metadata, body = self.provider_fixture()
        entry["timestamp"] = "2026-10-09T00:00:15Z"
        with self.assertRaises(ValueError):
            self.read_receipt(execution, entry, metadata, body)

    def test_reviewed_seed_plan_routes_exact_adoption_once(self):
        with (
            patch.object(
                MODULE.time, "time", return_value=self.binding["seed_created_unix"]
            ),
            patch.object(MODULE, "execute_bootstrap_job") as execution,
        ):
            MODULE.fenced_seed_phase(
                planning=True,
                work=self.work,
                env=self.env,
                release=self.release,
                database=self.database,
                versions=self.versions,
                migration_identity=self.identity,
                approval=None,
            )
        execution.assert_not_called()
        plan_file = self.work / "seed.plan.private.json"
        approved = approval(hashlib.sha256(plan_file.read_bytes()).hexdigest())
        approved["allowed_phases"] = ["seed"]
        captured = []

        def execute(descriptor, *, work):
            captured.append(descriptor)
            self.write(
                work / "bootstrap-adopt.receipt.private.json",
                {"execution": descriptor["job"]["name"] + "/executions/adopt-123"},
            )

        with (
            patch.object(MODULE, "execute_bootstrap_job", side_effect=execute),
            patch.object(
                MODULE,
                "read_fenced_seed_receipt",
                return_value={"seed_generation": "7"},
            ) as read,
        ):
            MODULE.fenced_seed_phase(
                planning=False,
                work=self.work,
                env=self.env,
                release=self.release,
                database=self.database,
                versions=self.versions,
                migration_identity=self.identity,
                approval=approved,
            )
        self.assertEqual(len(captured), 1)
        self.assertEqual(captured[0]["phase"], "adopt")
        read.assert_called_once()
        self.assertTrue((self.work / "seed.receipt.private.json").exists())
        with (
            patch.object(MODULE, "execute_bootstrap_job") as execution,
            self.assertRaises(ValueError),
        ):
            MODULE.fenced_seed_phase(
                planning=False,
                work=self.work,
                env=self.env,
                release=self.release,
                database=self.database,
                versions=self.versions,
                migration_identity=self.identity,
                approval=approved,
            )
        execution.assert_not_called()

    def test_hosting_build_plan_dispatch_has_no_provider_or_publication(self):
        helper = SimpleNamespace(
            inputs=MagicMock(return_value=(self.env, self.release, {}, {})),
            prepare_hosting_export=MagicMock(),
            publish_hosting_export=MagicMock(),
            run_browser_acceptance=MagicMock(),
        )
        fake_spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda _: None))
        with (
            patch.object(
                MODULE.importlib.util, "spec_from_file_location", return_value=fake_spec
            ),
            patch.object(
                MODULE.importlib.util, "module_from_spec", return_value=helper
            ),
            patch.object(MODULE, "run_command") as command,
        ):
            MODULE.hosting_phase(
                phase="hosting-plan",
                env_file=self.work / "env",
                release_file=self.work / "release",
                work=self.work,
                approval_file=None,
                dry_run=False,
            )
        command.assert_not_called()
        helper.prepare_hosting_export.assert_called_once()
        helper.publish_hosting_export.assert_not_called()
        helper.run_browser_acceptance.assert_not_called()

    def test_readback_plan_routes_exact_applied_private_identity(self):
        self.write(self.work / "database.private.json", self.database)
        self.write(self.work / "migration-identity.private.json", self.identity)
        helper = SimpleNamespace(prepare_readback_job=MagicMock())
        fake_spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda _: None))
        with (
            patch.object(
                MODULE.importlib.util, "spec_from_file_location", return_value=fake_spec
            ),
            patch.object(
                MODULE.importlib.util, "module_from_spec", return_value=helper
            ),
            patch.object(MODULE, "execute_bootstrap_job") as execute,
        ):
            MODULE.readback_phase(
                planning=True,
                env_file=self.work / "env",
                env=self.env,
                release=self.release,
                work=self.work,
                versions=self.versions,
                approval=None,
            )
        execute.assert_not_called()
        source = helper.prepare_readback_job.call_args.args[3]
        self.assertEqual(
            source["MARKETING_MIGRATION_IMAGE"],
            self.release["auxiliary_images"]["migrations"],
        )
        self.assertEqual(
            source["MARKETING_MIGRATION_SERVICE_ACCOUNT"], self.identity["email"]
        )
        self.assertEqual(source["CLOUD_SQL_PRIVATE_IP"], self.database["private_ip"])
        self.assertEqual(source["MARKETING_ADMIN_DB_URL_SECRET_VERSION"], "7")

    def auth_ingress_plan(self):
        values = {
            "project_id": "axiom-proof",
            "release_sha": SHA,
            "images": self.release["images"],
            "service_secrets": {},
            "lifecycle_seed_generation": "7",
            "lifecycle_seed_target_sha256": PIN,
        }
        variables = {
            key: {"value": value}
            for key, value in {
                "project_id": "axiom-proof",
                "environment": "preprod",
                "region": "asia-south1",
                "release_sha": SHA,
                "deploy_services": True,
                "images": values["images"],
                "service_secrets": {},
                "lifecycle_scheduler_paused": True,
                "auth_bootstrap_only": False,
                "lifecycle_state_initialized": True,
                "lifecycle_seed_generation": "7",
                "lifecycle_seed_target_sha256": PIN,
            }.items()
        }
        before = {
            "project": "axiom-proof",
            "location": "asia-south1",
            "ingress": "INGRESS_TRAFFIC_INTERNAL_ONLY",
            "template": [
                {
                    "containers": [
                        {
                            "image": self.release["images"]["auth"],
                            "env": [
                                {
                                    "name": "SECRET",
                                    "value_source": {
                                        "secret_key_ref": {
                                            "secret": "selected-secret",
                                            "version": "7",
                                        }
                                    },
                                }
                            ],
                        }
                    ],
                    "service_account": "selected@test-project.iam.gserviceaccount.com",
                }
            ],
        }
        change = {
            "address": "module.auth[0].google_cloud_run_v2_service.request",
            "module_address": "module.auth[0]",
            "mode": "managed",
            "change": {
                "actions": ["update"],
                "before": before,
                "after": {**before, "ingress": "INGRESS_TRAFFIC_ALL"},
            },
        }
        return values, {
            "variables": variables,
            "resource_changes": [
                change,
                {
                    "address": "module.bff[0].google_cloud_run_v2_service.request",
                    "module_address": "module.bff[0]",
                    "mode": "managed",
                    "change": {
                        "actions": ["create"],
                        "after": {"project": "axiom-proof", "location": "asia-south1"},
                    },
                },
            ],
        }

    def test_exact_final_auth_ingress_update_only(self):
        values, document = self.auth_ingress_plan()
        self.assertEqual(
            MODULE.inspect_service_plan(document, values=values, phase="services")[
                "update"
            ],
            1,
        )
        for drift in (
            "image",
            "secret",
            "identity",
            "phase-flag",
            "service",
            "project",
            "region",
        ):
            with self.subTest(drift=drift):
                values, document = self.auth_ingress_plan()
                change = document["resource_changes"][0]
                if drift == "phase-flag":
                    document["variables"]["auth_bootstrap_only"]["value"] = True
                elif drift == "service":
                    change["address"] = (
                        "module.bff[0].google_cloud_run_v2_service.request"
                    )
                    change["module_address"] = "module.bff[0]"
                elif drift in ("project", "region"):
                    key = "project" if drift == "project" else "location"
                    change["change"]["before"][key] = "foreign"
                    change["change"]["after"][key] = "foreign"
                else:
                    # Isolate the after template so the before proof remains exact.
                    after = json.loads(json.dumps(change["change"]["after"]))
                    change["change"]["after"] = after
                    template = after["template"][0]
                    if drift == "image":
                        template["containers"][0]["image"] += "different"
                    elif drift == "secret":
                        template["containers"][0]["env"][0]["value_source"][
                            "secret_key_ref"
                        ]["version"] = "8"
                    else:
                        template["service_account"] = (
                            "foreign@test-project.iam.gserviceaccount.com"
                        )
                with self.assertRaises(ValueError):
                    MODULE.inspect_service_plan(
                        document, values=values, phase="services"
                    )


class CloudCredentialTransportTests(unittest.TestCase):
    def test_transport_does_not_forward_bearer_to_foreign_or_insecure_origins(self):
        for url in ("http://run.googleapis.com/v2/jobs", "https://attacker.invalid/",
                    "https://run.googleapis.com.attacker.invalid/", "https://run.googleapis.com:444/",
                    "https://user@run.googleapis.com/v2/jobs"):
            with self.subTest(url=url), patch.object(MODULE, "build_opener") as opener:
                with self.assertRaises(ValueError):
                    MODULE.urlopen(MODULE.Request(url, headers={"Authorization": "Bearer synthetic"}), timeout=20)
                opener.assert_not_called()

    def test_transport_disables_ambient_proxy_and_preserves_exact_request(self):
        req = MODULE.Request("https://run.googleapis.com/v2/projects/axiom-proof/locations/asia-south1/jobs")
        with patch.object(MODULE, "build_opener") as opener:
            MODULE.urlopen(req, timeout=20)
            proxy, redirect = opener.call_args.args
            self.assertEqual(proxy.proxies, {})
            self.assertIsInstance(redirect, MODULE.NoCloudRedirect)
            opener.return_value.open.assert_called_once_with(req, timeout=20)

    def test_provider_redirect_is_refused_without_reissuing_request(self):
        req = MODULE.Request("https://storage.googleapis.com/storage/v1/b/selected/o/object")
        with self.assertRaises(ValueError):
            MODULE.NoCloudRedirect().redirect_request(req, None, 302, "redirect", {}, "https://attacker.invalid/")


if __name__ == "__main__":
    unittest.main()
