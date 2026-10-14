"""Actual Helm rendering for explicit sovereign config, without cluster access."""

import os
import pathlib
import shutil
import subprocess
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[4]
CHART = ROOT / "infra/helm/axiom-proof"
LOCAL_HELM = ROOT / ".axiom-runtime/review/sovereign-helm-parity/tools/helm"
HELM = shutil.which("helm") or (str(LOCAL_HELM) if LOCAL_HELM.exists() else None)
COMPONENTS = (
    "web",
    "marketing",
    "bff",
    "agent-runtime",
    "model-gateway",
    "temporal-worker",
)


def render(onprem=False, overrides=()):
    args = [HELM, "template", "axiom-proof", str(CHART)]
    if onprem:
        args += [
            "-f",
            str(CHART / "values-onprem.yaml"),
            "-f",
            str(CHART / "ci/onprem-inputs.yaml"),
        ]
    for value in overrides:
        args += ["--set-string", value]
    return subprocess.run(args, capture_output=True, text=True, check=False, timeout=30)


def deployments(result):
    return {
        doc["metadata"]["labels"]["app.kubernetes.io/component"]: doc
        for doc in yaml.safe_load_all(result.stdout)
        if isinstance(doc, dict) and doc.get("kind") == "Deployment"
    }


def container(deployment):
    return deployment["spec"]["template"]["spec"]["containers"][0]


@unittest.skipUnless(HELM, "actual Helm binary unavailable; helm-render CI requires it")
class SovereignHelmTests(unittest.TestCase):
    def test_production_defaults_preserve_images_policy_and_license_absence(self):
        result = render()
        self.assertEqual(result.returncode, 0, result.stderr)
        for component, deployment in deployments(result).items():
            pod = container(deployment)
            self.assertEqual(
                pod["image"], f"ghcr.io/axiom-minds/axiom-{component}:0.1.0"
            )
            self.assertEqual(pod["imagePullPolicy"], "IfNotPresent")
            env = {entry["name"]: entry for entry in pod["env"]}
            self.assertEqual(env["ENVIRONMENT"]["value"], "production")
            self.assertNotIn("AXIOM_OFFLINE_LICENSE", env)
            self.assertNotIn("AXIOM_LICENSE_ROOT_PUBLIC_KEY", env)
            if component == "model-gateway":
                self.assertIn("API_KEY", env)
                self.assertNotIn("MODEL_GATEWAY_API_KEY", env)

    def test_onprem_renders_immutable_offline_and_scoped_service_contract(self):
        result = render(True)
        self.assertEqual(result.returncode, 0, result.stderr)
        docs = deployments(result)
        self.assertEqual(set(docs), set(COMPONENTS))
        for component, deployment in docs.items():
            pod = container(deployment)
            self.assertEqual(
                pod["image"],
                f"registry.local/axiom-minds/axiom-{component}@sha256:" + "a" * 64,
            )
            self.assertEqual(pod["imagePullPolicy"], "Never")
            env = {entry["name"]: entry for entry in pod["env"]}
            for entry in env.values():
                self.assertNotEqual(
                    "value" in entry, "valueFrom" in entry, entry["name"]
                )
            self.assertEqual(env["ENVIRONMENT"]["value"], "onprem")
            licensed = component in (
                "bff",
                "agent-runtime",
                "model-gateway",
                "temporal-worker",
            )
            for name, key in (
                ("AXIOM_OFFLINE_LICENSE", "license"),
                ("AXIOM_LICENSE_ROOT_PUBLIC_KEY", "root-public-key"),
            ):
                self.assertEqual(name in env, licensed)
                if licensed:
                    self.assertEqual(
                        env[name],
                        {
                            "name": name,
                            "valueFrom": {
                                "secretKeyRef": {
                                    "name": "axiom-proof-onprem-license",
                                    "key": key,
                                }
                            },
                        },
                    )
            for name in (
                "AXIOM_STORAGE_ACCESS_KEY_ID",
                "AXIOM_STORAGE_SECRET_ACCESS_KEY",
                "AXIOM_STORAGE_ENDPOINT",
            ):
                self.assertEqual(name in env, component in ("bff", "agent-runtime"))
            if component in ("agent-runtime", "temporal-worker"):
                self.assertEqual(env["TEMPORAL_TLS"]["value"], "false")
                self.assertNotIn("TEMPORAL_API_KEY", env)
            if component == "model-gateway":
                self.assertEqual(
                    env["SELF_HOSTED_BASE_URL"]["value"], "http://local-model:8000"
                )
                self.assertEqual(env["PII_REDACTION_ENABLED"]["value"], "true")
                self.assertIn("API_KEY", env)
                self.assertNotIn("MODEL_GATEWAY_API_KEY", env)
        scoped = subprocess.run(
            ["python3", str(CHART / "ci/assert-secret-scoping.py")],
            check=False,
            input=result.stdout,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(scoped.returncode, 0, scoped.stderr)

    def test_guard_refuses_wrong_license_secret_key_in_each_backend(self):
        result = render(True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for component in ("bff", "agent-runtime", "model-gateway", "temporal-worker"):
            for name in ("AXIOM_OFFLINE_LICENSE", "AXIOM_LICENSE_ROOT_PUBLIC_KEY"):
                with self.subTest(component=component, name=name):
                    docs = list(yaml.safe_load_all(result.stdout))
                    deployment = next(
                        doc
                        for doc in docs
                        if isinstance(doc, dict)
                        and doc.get("kind") == "Deployment"
                        and doc["metadata"]["labels"]["app.kubernetes.io/component"]
                        == component
                    )
                    env = next(
                        entry
                        for entry in container(deployment)["env"]
                        if entry["name"] == name
                    )
                    env["valueFrom"]["secretKeyRef"]["key"] = "authority-private-key"
                    guarded = subprocess.run(
                        ["python3", str(CHART / "ci/assert-secret-scoping.py")],
                        input=yaml.safe_dump_all(docs),
                        capture_output=True,
                        text=True,
                        check=False,
                        timeout=30,
                    )
                    self.assertNotEqual(guarded.returncode, 0)
                    self.assertIn(name, guarded.stderr)

    def test_guard_refuses_private_offline_authority_env_without_banning_approval(self):
        result = render(True)
        self.assertEqual(result.returncode, 0, result.stderr)
        safe = deployments(result)
        self.assertEqual(set(safe), set(COMPONENTS))
        self.assertIn(
            "APPROVAL_SIGNING_KEY",
            {entry["name"] for entry in container(safe["bff"])["env"]},
        )
        for component in COMPONENTS:
            for name in (
                "AXIOM_LICENSE_AUTHORITY_PRIVATE_KEY",
                "AXIOM_LICENSE_ROOT_PRIVATE_KEY",
                "AXIOM_OFFLINE_LICENSE_PRIVATE_KEY",
            ):
                with self.subTest(component=component, name=name):
                    docs = list(yaml.safe_load_all(result.stdout))
                    deployment = next(
                        doc
                        for doc in docs
                        if isinstance(doc, dict)
                        and doc.get("kind") == "Deployment"
                        and doc["metadata"]["labels"]["app.kubernetes.io/component"]
                        == component
                    )
                    container(deployment)["env"].append(
                        {"name": name, "value": "synthetic-unissued-authority-field"}
                    )
                    guarded = subprocess.run(
                        ["python3", str(CHART / "ci/assert-secret-scoping.py")],
                        input=yaml.safe_dump_all(docs),
                        capture_output=True,
                        text=True,
                        check=False,
                        timeout=30,
                    )
                    self.assertNotEqual(guarded.returncode, 0)
                    self.assertIn(name, guarded.stderr)

    def test_onprem_example_refuses_without_approved_inputs(self):
        result = subprocess.run(
            [
                HELM,
                "template",
                "axiom-proof",
                str(CHART),
                "-f",
                str(CHART / "values-onprem.yaml"),
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)

    def test_missing_and_invalid_digests_each_refuse(self):
        for component in COMPONENTS:
            for digest in ("", "latest", "sha256:abc", "sha256:" + "A" * 64):
                with self.subTest(component=component, digest=digest):
                    result = render(True, [f"image.digests.{component}={digest}"])
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(component, result.stderr)

    def test_missing_required_secrets_endpoint_and_online_pull_policy_refuse(self):
        for override, expected in (
            ("config.offlineLicenseSecretName=", "offlineLicenseSecretName"),
            ("config.storageSecretName=", "storageSecretName"),
            ("config.storageEndpoint=", "storageEndpoint"),
            ("image.pullPolicy=IfNotPresent", "Never"),
            ("config.environment=development", "production or onprem"),
        ):
            with self.subTest(override=override):
                result = render(True, [override])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)


if __name__ == "__main__":
    if os.environ.get("AXIOM_REQUIRE_HELM") == "1" and not HELM:
        raise SystemExit("actual Helm required for sovereign render regressions")
    unittest.main()
