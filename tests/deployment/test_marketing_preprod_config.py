"""Pure contract tests for the protected marketing Terraform profile generator."""

from __future__ import annotations

import copy
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "marketing_preprod_config", ROOT / "scripts/marketing-preprod-config.py"
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
PIN = "a" * 64
COMPONENTS = ("marketing", "bff", "auth", "rest", "gateway")


def valid_inputs() -> tuple[dict[str, str], dict, dict[str, str]]:
    env = MODULE.loader.parse(ROOT / "infra/docker/environments/.env.preprod.example")
    env["CLOUD_SQL_ADMIN_PASSWORD"] = "a" * 40
    release = {
        "release_sha": "b" * 40,
        "images": {
            component: f"asia-south1-docker.pkg.dev/axiom-proof/axiom-proof-preprod-images/{component}@sha256:{PIN}"
            for component in COMPONENTS
        },
    }
    versions = {
        env[key]: str(index)
        for index, key in enumerate(
            (
                "MARKETING_AUTH_DB_URL_SECRET",
                "MARKETING_JWT_SECRET",
                "MARKETING_REST_DB_URL_SECRET",
                "MARKETING_SERVICE_KEY_SECRET",
                "MARKETING_EMAIL_KEY_SECRET",
            ),
            1,
        )
    }
    return env, release, versions


class MarketingProfileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.env, self.release, self.versions = valid_inputs()

    def profile(self, services: bool = False) -> dict:
        return MODULE.profile(self.env, self.release, self.versions, services)

    def test_base_phase_preserves_explicit_project_names_and_no_versions_required(self) -> None:
        result = MODULE.profile(self.env, self.release, {}, False)
        self.assertEqual(result["project_id"], "axiom-proof")
        self.assertEqual(result["region"], "asia-south1")
        self.assertEqual(result["environment"], "preprod")
        self.assertFalse(result["deploy_services"])
        self.assertEqual(set(result["images"]), set(COMPONENTS))
        self.assertEqual(result["service_names"]["marketing"], "axiom-proof-preprod-marketing")
        self.assertEqual(result["firebase_origin"], "https://stg.axiomproof.ai")
        self.assertEqual(result["service_secrets"]["auth"]["GOTRUE_JWT_SECRET"]["version"], "")

    def test_service_phase_uses_exact_secret_ids_and_versions(self) -> None:
        result = self.profile(True)
        self.assertTrue(result["deploy_services"])
        for service, key, source in (
            ("auth", "GOTRUE_DB_DATABASE_URL", "MARKETING_AUTH_DB_URL_SECRET"),
            ("auth", "GOTRUE_JWT_SECRET", "MARKETING_JWT_SECRET"),
            ("rest", "PGRST_DB_URI", "MARKETING_REST_DB_URL_SECRET"),
            ("rest", "PGRST_JWT_SECRET", "MARKETING_JWT_SECRET"),
            ("bff", "SUPABASE_SERVICE_KEY", "MARKETING_SERVICE_KEY_SECRET"),
        ):
            self.assertEqual(
                result["service_secrets"][service][key],
                {"secret": self.env[source], "version": self.versions[self.env[source]]},
            )
        self.assertEqual(
            result["service_secrets"]["auth"]["GOTRUE_JWT_SECRET"],
            result["service_secrets"]["rest"]["PGRST_JWT_SECRET"],
        )
        for key in ("GOTRUE_DB_DATABASE_URL", "GOTRUE_JWT_SECRET", "PGRST_DB_URI", "PGRST_JWT_SECRET", "SUPABASE_SERVICE_KEY"):
            self.assertFalse(any(key in values for values in result["service_env"].values()))

    def test_delivery_email_requires_version_and_uses_secret_ref(self) -> None:
        self.env["AXIOM_CONTACT_EMAIL_MODE"] = "delivery"
        self.versions.pop(self.env["MARKETING_EMAIL_KEY_SECRET"])
        with self.assertRaises(ValueError):
            self.profile(True)
        self.versions[self.env["MARKETING_EMAIL_KEY_SECRET"]] = "17"
        result = self.profile(True)
        self.assertEqual(result["service_secrets"]["bff"]["RESEND_API_KEY"], {
            "secret": self.env["MARKETING_EMAIL_KEY_SECRET"], "version": "17"
        })
        self.assertNotIn("RESEND_API_KEY", result["service_env"]["bff"])
        for key in ("AXIOM_FROM_EMAIL", "CONTACT_RECIPIENT_EMAIL", "AXIOM_SALES_EMAIL", "AXIOM_FOUNDER_EMAIL"):
            self.assertEqual(result["service_env"]["bff"][key], self.env[key])

    def test_disabled_email_has_no_delivery_key(self) -> None:
        result = self.profile(True)
        self.assertNotIn("RESEND_API_KEY", result["service_secrets"]["bff"])
        self.assertNotIn("AXIOM_FROM_EMAIL", result["service_env"]["bff"])

    def test_absent_required_key_never_falls_back_to_process_environment(self) -> None:
        self.env.pop("GCP_PROJECT_ID")
        with patch.dict(os.environ, {"GCP_PROJECT_ID": "axiom-proof"}):
            with self.assertRaises(ValueError):
                self.profile()

    def test_plaintext_runtime_secret_values_are_not_mapped_into_service_env(self) -> None:
        sentinels = {
            "SUPABASE_SERVICE_KEY": "plaintext-service-key-sentinel",
            "GOTRUE_JWT_SECRET": "plaintext-jwt-sentinel",
            "RESEND_API_KEY": "plaintext-email-key-sentinel",
        }
        self.env.update(sentinels)
        result = self.profile(True)
        serialized = json.dumps(result)
        for plaintext in sentinels.values():
            self.assertNotIn(plaintext, serialized)
        self.assertEqual(result["service_env"]["bff"]["AXIOM_REPORT_EMAIL_MODE"], "disabled")

    def test_placeholder_required_key_refused(self) -> None:
        self.env["MARKETING_JWT_SECRET"] = "<secret-name>"
        with self.assertRaises(ValueError):
            self.profile()

    def test_conflicting_aliases_refused(self) -> None:
        for alias, value in (("AXIOM_PROJECT_ID", "wrong-project"), ("AXIOM_REGION", "us-central1")):
            with self.subTest(alias=alias):
                env = copy.copy(self.env)
                env[alias] = value
                with self.assertRaises(ValueError):
                    MODULE.profile(env, self.release, self.versions, False)

    def test_matching_aliases_do_not_override_canonical_values(self) -> None:
        self.env["AXIOM_PROJECT_ID"] = self.env["GCP_PROJECT_ID"]
        self.env["AXIOM_REGION"] = self.env["GCP_REGION"]
        self.assertEqual(self.profile()["project_id"], self.env["GCP_PROJECT_ID"])

    def test_wrong_profile_environment_and_region_refused(self) -> None:
        for key, value in (("AXIOM_DEPLOYMENT_PROFILE", "full"), ("ENVIRONMENT", "production"), ("GCP_REGION", "us-central1")):
            with self.subTest(key=key):
                env = copy.copy(self.env)
                env[key] = value
                with self.assertRaises(ValueError):
                    MODULE.profile(env, self.release, self.versions, False)

    def test_images_require_exact_five_project_owned_immutable_digests(self) -> None:
        for component, image in (
            ("auth", "asia-south1-docker.pkg.dev/other/repo/auth@sha256:" + PIN),
            ("rest", "asia-south1-docker.pkg.dev/axiom-proof/repo/rest:latest"),
            ("gateway", "us-central1-docker.pkg.dev/axiom-proof/repo/gateway@sha256:" + PIN),
        ):
            with self.subTest(component=component):
                release = copy.deepcopy(self.release)
                release["images"][component] = image
                with self.assertRaises(ValueError):
                    MODULE.profile(self.env, release, self.versions, False)
        release = copy.deepcopy(self.release)
        del release["images"]["gateway"]
        with self.assertRaises(ValueError):
            MODULE.profile(self.env, release, self.versions, False)

    def test_service_phase_refuses_missing_or_non_numeric_versions(self) -> None:
        for value in (None, "latest", "0", "-1"):
            with self.subTest(value=value):
                versions = copy.copy(self.versions)
                key = self.env["MARKETING_SERVICE_KEY_SECRET"]
                if value is None:
                    del versions[key]
                else:
                    versions[key] = value
                with self.assertRaises(ValueError):
                    MODULE.profile(self.env, self.release, versions, True)

    def test_source_contract_matches_terraform_size_and_naming_gate(self) -> None:
        result = self.profile()
        tf = (ROOT / "infra/terraform/envs/marketing-preprod/main.tf").read_text()
        self.assertEqual((result["cloud_sql_tier"], result["cloud_sql_disk_size_gb"], result["cloud_sql_database_version"]), ("db-f1-micro", 10, "POSTGRES_15"))
        self.assertEqual((result["cloud_sql_backup_retention"], result["cloud_sql_pitr_enabled"], result["min_instance_count"], result["max_instance_count"]), (7, False, 0, 1))
        self.assertIn('var.cloud_sql_tier == "db-f1-micro"', tf)
        self.assertIn('var.cloud_sql_disk_size_gb == 10', tf)
        self.assertIn('var.max_instance_count == 1', tf)
        self.assertIn('^axiom-proof-preprod-[a-z0-9-]+$', tf)
        self.assertTrue(all(name.startswith("axiom-proof-preprod-") for name in result["service_names"].values()))


if __name__ == "__main__":
    unittest.main()
