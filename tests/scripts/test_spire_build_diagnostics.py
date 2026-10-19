"""Offline build-failure categories cannot disclose raw diagnostics or hide failure."""

import ast
import contextlib
import importlib.util
import io
import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "fixture_build_diagnostics", ROOT / "scripts/lib/ci_fixture_images.py"
)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
BUILD = [
    "docker",
    "build",
    "--target",
    "vm-controller-acceptance",
    "-f",
    "infra/docker/Dockerfile.bff",
    "-t",
    "axiom-spire-health-probe:acceptance",
    ".",
]


class BuildDiagnostics(unittest.TestCase):
    def diagnostic(self, stderr, args=None):
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            m.report_public_fixture_build(BUILD if args is None else args, stderr)
        text = output.getvalue()
        if not text:
            return None
        prefix = "SPIRE acceptance image build failure: "
        self.assertTrue(text.startswith(prefix))
        self.assertEqual(len(text.splitlines()), 1)
        return json.loads(text[len(prefix) :])

    def test_exact_build_emits_only_static_compiler_codes_not_private_lines(self):
        secret = "SECRET-private-token-90210"
        result = self.diagnostic(
            "/home/private/file.ts(1): error TS2307: "
            + secret
            + " https://user:"
            + secret
            + "@private.invalid\nERR_PNPM_RECURSIVE_RUN_FIRST_FAIL "
            + secret
        )
        self.assertEqual(
            result,
            {
                "category": "TypeScript compilation failed",
                "codes": ["ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL", "TS2307"],
            },
        )
        self.assertNotIn(secret, json.dumps(result))
        self.assertNotIn("/home/", json.dumps(result))
        self.assertNotIn("private.invalid", json.dumps(result))

    def test_known_address_property_compile_failure_has_safe_static_code(self):
        result = self.diagnostic(
            "src/private.test.ts(44,12): error TS2339: Property address does not exist on type string | AddressInfo\nsrc/private.test.ts(45,12): error TS2339: secret diagnostic"
        )
        self.assertEqual(
            result, {"category": "TypeScript compilation failed", "codes": ["TS2339"]}
        )

    def test_unlisted_tool_codes_are_never_echoed(self):
        self.assertEqual(
            self.diagnostic("error TS9999: secret\nERR_PNPM_PRIVATE_TOKEN_1234"),
            {"category": "TypeScript compilation failed", "codes": []},
        )
        self.assertEqual(
            self.diagnostic(
                "error TS2307_SECRET: sensitive\nERR_PNPM_FETCH_404_SECRET"
            ),
            {"category": "acceptance image build failed", "codes": []},
        )

    def test_fixed_categories(self):
        cases = [
            ("no space left on device /private", "build storage unavailable"),
            ("process exited: exit code: 137", "build process resource failure"),
            ("ERR_PNPM_OUTDATED_LOCKFILE /private", "dependency lockfile refused"),
            ("429 Too Many Requests https://private", "build registry rate limit"),
            ("manifest unknown private/image", "build registry manifest unavailable"),
            ("digest mismatch SECRET", "build content integrity failed"),
            (
                "x509: certificate rejected privatehost",
                "build transport certificate refused",
            ),
            (
                "/bin/sh -c apk add --no-cache private\nERROR: unable to select packages",
                "Alpine package installation failed",
            ),
            ("failed to calculate checksum /private", "build context unavailable"),
            ("ERR_PNPM_FETCH_503 privatehost", "dependency retrieval failed"),
            (
                "Cannot connect to the Docker daemon /private.sock",
                "build daemon unavailable",
            ),
            ("arbitrary private error and credential", "acceptance image build failed"),
        ]
        for stderr, expected in cases:
            with self.subTest(category=expected):
                self.assertEqual(self.diagnostic(stderr)["category"], expected)

    def test_only_exact_allowlisted_target_file_tag_context_and_options_allowed(self):
        cases = [
            ["docker", "build", "."],
            BUILD + ["--secret", "id=private,src=/private"],
            BUILD + ["--build-arg", "TOKEN=secret"],
            ["sudo", *BUILD],
            ["docker", "pull", "private/secret"],
        ]
        for index, replacement in [
            (3, "runtime"),
            (5, "/private/Dockerfile"),
            (7, "private/secret:tag"),
            (8, "/private/context"),
        ]:
            changed = list(BUILD)
            changed[index] = replacement
            cases.append(changed)
        for args in cases:
            self.assertIsNone(self.diagnostic("secret error TS2307", args))

    def test_bounded_stderr_does_not_retain_or_print_large_private_prefix(self):
        result = self.diagnostic(
            "error TS2307: sensitive\n" + "x" * 300000 + "\nunknown"
        )
        self.assertEqual(
            result, {"category": "acceptance image build failed", "codes": []}
        )

    def test_failure_still_raises_and_never_retries_or_prints_output(self):
        source = ROOT / "scripts/test-spire-deployment.py"
        tree = ast.parse(source.read_text())
        run = next(
            n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "run"
        )
        environment = {
            "subprocess": subprocess,
            "ROOT": ROOT,
            "report_public_image_startup": lambda *a: None,
            "report_public_fixture_build": m.report_public_fixture_build,
        }
        exec(  # noqa: S102 - fixed source AST with mocked subprocess only
            compile(ast.Module(body=[run], type_ignores=[]), str(source), "exec"),
            environment,
        )
        result = subprocess.CompletedProcess(
            BUILD, 1, "SECRET-stdout", "error TS2307: SECRET-stderr"
        )
        output = io.StringIO()
        with (
            patch.object(subprocess, "run", return_value=result) as invoke,
            contextlib.redirect_stderr(output),
            self.assertRaisesRegex(RuntimeError, "command refused"),
        ):
            environment["run"](BUILD)
        self.assertEqual(invoke.call_count, 1)
        self.assertNotIn("SECRET", output.getvalue())
        self.assertIn("TS2307", output.getvalue())


if __name__ == "__main__":
    unittest.main()
