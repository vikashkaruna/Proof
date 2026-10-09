"""CI fixture transport/refusal tests; no Docker, registry or credentials used."""

import contextlib
import importlib.util
import io
import os
import runpy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "ci_fixture_images", ROOT / "scripts/lib/ci_fixture_images.py"
)
images = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(images)
ALPINE = "alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8"
CI = {
    "AXIOM_CI_DOCKER_MIRROR": "1",
    "GITHUB_ACTIONS": "true",
    "RUNNER_ENVIRONMENT": "github-hosted",
    "RUNNER_OS": "Linux",
}


class FixtureImageTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, {}, clear=True))
        self.enterContext(patch.object(images.platform, "system", return_value="Linux"))

    def test_default_preserves_source_reference(self):
        self.assertEqual(images.fixture_image(ALPINE), ALPINE)

    def test_opt_in_preserves_exact_source_tag_and_digest(self):
        sources = [
            ALPINE,
            "python:3.12-alpine3.22@sha256:a190708a2dec1bd18b1decb539f8e8f5407abaa9bf39cacda583f7f8c11db322",
            "ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3",
            "docker.io/library/golang@sha256:4ed690d6649d63c312b99a6120025ec79ce3b542968a37da53d6236c7c61a848",
        ]
        with patch.dict(os.environ, CI):
            for source in sources:
                with self.subTest(source=source):
                    mirrored = images.fixture_image(source)
                    self.assertTrue(mirrored.startswith("mirror.gcr.io/library/"))
                    suffix = source.removeprefix("docker.io/library/")
                    self.assertEqual(
                        mirrored.removeprefix("mirror.gcr.io/library/"), suffix
                    )

    def test_opt_in_refuses_missing_invalid_or_nonhosted_context(self):
        for key in CI:
            for replacement in (None, "", "false", "self-hosted"):
                changed = dict(CI)
                if replacement is None:
                    changed.pop(key)
                    if key == "AXIOM_CI_DOCKER_MIRROR":
                        continue  # Omitted opt-in deliberately retains the local source.
                else:
                    changed[key] = replacement
                with (
                    self.subTest(key=key, replacement=replacement),
                    patch.dict(os.environ, changed, clear=True),
                    self.assertRaises(ValueError),
                ):
                    images.fixture_image(ALPINE)
        with (
            patch.dict(os.environ, CI),
            patch.object(images.platform, "system", return_value="Darwin"),
            self.assertRaises(ValueError),
        ):
            images.fixture_image(ALPINE)

    def test_unknown_or_altered_source_refuses_even_without_opt_in(self):
        for source in (
            "alpine:latest",
            ALPINE.replace("3.22", "3.21"),
            ALPINE[:-1] + "0",
            "attacker.example/" + ALPINE,
        ):
            with self.subTest(source=source), self.assertRaises(ValueError):
                images.fixture_image(source)

    def test_public_startup_diagnostic_never_relays_stderr_or_arguments(self):
        secret = "synthetic-do-not-print-token"
        for stderr, category in (
            ("toomanyrequests " + secret, "registry rate limit"),
            ("manifest unknown " + secret, "registry manifest unavailable"),
            ("unauthorized " + secret, "registry access refused"),
            ("tls handshake " + secret, "registry connection failed"),
            (secret, "public image startup failed"),
        ):
            with (
                self.subTest(category=category),
                contextlib.redirect_stderr(io.StringIO()) as output,
            ):
                images.report_public_image_startup(["docker", "pull", ALPINE], stderr)
                self.assertEqual(
                    output.getvalue(),
                    "Public fixture Docker preflight refused: " + category + ".\n",
                )
                self.assertNotIn(secret, output.getvalue())

    def test_exec_build_token_operations_and_unknown_images_emit_nothing(self):
        commands = [
            ["docker", "exec", "issuer", "token", "generate"],
            ["docker", "build", "-t", "fixture", "."],
            ["docker", "pull", "unknown.example/image"],
            ["docker", "run", "--entrypoint", "sh", ALPINE, "1200"],
            ["docker", "run", "--entrypoint", "sleep", ALPINE, "token"],
        ]
        for args in commands:
            with (
                self.subTest(args=args),
                contextlib.redirect_stderr(io.StringIO()) as output,
            ):
                images.report_public_image_startup(
                    args, "toomanyrequests synthetic-secret"
                )
                self.assertEqual(output.getvalue(), "")

    def test_all_changed_harnesses_preserve_defaults_and_consume_opt_in(self):
        harnesses = {
            "test-workload-identity.py": ["IMAGE"],
            "test-spire-deployment.py": ["IMAGE", "PYTHON_IMAGE"],
            "test-workload-host.py": ["UBUNTU"],
            "test-workload-runner-systemd.py": ["ALPINE"],
            "test-evidence-storage.py": ["BUILDER"],
        }
        with patch.object(sys, "path", [str(ROOT / "scripts"), *sys.path]):
            for name, variables in harnesses.items():
                with self.subTest(harness=name):
                    local = runpy.run_path(str(ROOT / "scripts" / name))
                    with patch.dict(os.environ, CI):
                        hosted = runpy.run_path(str(ROOT / "scripts" / name))
                    for variable in variables:
                        self.assertFalse(local[variable].startswith("mirror.gcr.io/"))
                        self.assertEqual(
                            hosted[variable],
                            "mirror.gcr.io/library/"
                            + local[variable].removeprefix("docker.io/library/"),
                        )

    def test_workload_harness_consumes_mirror_and_reports_mock_startup_failure(self):
        with (
            patch.dict(os.environ, CI),
            patch.object(sys, "path", [str(ROOT / "scripts"), *sys.path]),
        ):
            harness = runpy.run_path(str(ROOT / "scripts/test-workload-identity.py"))
        selected = harness["IMAGE"]
        self.assertEqual(selected, "mirror.gcr.io/library/" + ALPINE)
        result = type(
            "Result",
            (),
            {"returncode": 1, "stderr": "toomanyrequests synthetic-secret"},
        )()
        with (
            patch.object(harness["subprocess"], "run", return_value=result),
            contextlib.redirect_stderr(io.StringIO()) as output,
            self.assertRaises(RuntimeError),
        ):
            harness["run"](
                ["docker", "run", "-d", "--entrypoint", "sleep", selected, "1200"]
            )
        self.assertEqual(
            output.getvalue(),
            "Public fixture Docker preflight refused: registry rate limit.\n",
        )

    def test_selfhosted_shell_uses_default_and_explicit_ingress_images(self):
        mirror = (
            "mirror.gcr.io/library/nginx:alpine@sha256:"
            "df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2"
        )
        for override, expected in ((None, "nginx:alpine"), (mirror, mirror)):
            with self.subTest(override=override), tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp)
                stubs = {
                    "docker": """#!/bin/bash
case "$1" in
 image) exit 0;;
 logs) echo 'GoTrue API started';;
 port) echo '127.0.0.1:12345';;
 run)
   for arg in "$@"; do
     case "$arg" in axiom-sh-gw-*) printf '%s\\n' "${!#}" > "$IMAGE_LOG"; exit 23;; esac
   done;;
esac
""",
                    "node": """#!/bin/bash
for key in SUPABASE_JWT_SECRET SUPABASE_ANON_KEY SUPABASE_SERVICE_KEY SUPABASE_ARCHIVE_WRITER_KEY SUPABASE_HUMAN_ACTION_WRITER_KEY SUPABASE_AGENT_LEDGER_WRITER_KEY; do
 echo "$key=synthetic-shell-fixture"
done
""",
                    "psql": """#!/bin/bash
case "${!#}" in
 *'count(*)'*) echo 61;;
 *'pg_type'*) echo auth;;
esac
""",
                    "python3": "#!/bin/bash\nexit 0\n",
                }
                for name, body in stubs.items():
                    path = directory / name
                    path.write_text(body)
                    path.chmod(0o700)
                env = {
                    "PATH": f"{directory}:/usr/bin:/bin",
                    "TMPDIR": tmp,
                    "IMAGE_LOG": str(directory / "image.log"),
                }
                if override is not None:
                    env["AXIOM_TEST_INGRESS_IMAGE"] = override
                result = subprocess.run(
                    [
                        "/bin/bash",
                        str(ROOT / "tests/deployment/selfhosted-supabase.sh"),
                    ],
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                )
                self.assertEqual(result.returncode, 23, result.stderr)
                self.assertEqual(
                    (directory / "image.log").read_text().strip(), expected
                )


if __name__ == "__main__":
    unittest.main()
