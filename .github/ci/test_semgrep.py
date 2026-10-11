"""Real synthetic rule checks and mocked scan/error boundaries. Never upload scans."""

import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "run_semgrep", Path(__file__).with_name("run_semgrep.py")
)
scanner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scanner)


class SemgrepPolicyTests(unittest.TestCase):
    def test_reviewed_policy_validates(self):
        scanner.validate_policy()

    def test_missing_changed_extra_rule_or_missing_license_refuses(self):
        for mutation in (
            "missing-rule",
            "changed-rule",
            "extra-rule",
            "missing-license",
        ):
            with (
                self.subTest(mutation=mutation),
                tempfile.TemporaryDirectory() as directory,
            ):
                policy = Path(directory).resolve() / "policy"
                shutil.copytree(scanner.POLICY, policy)
                rule = next((policy / "rules").rglob("*.yaml"))
                if mutation == "missing-rule":
                    rule.unlink()
                elif mutation == "changed-rule":
                    rule.write_text(rule.read_text() + "\n# changed content\n")
                elif mutation == "extra-rule":
                    (policy / "rules/unreviewed.yaml").write_text("rules: []\n")
                else:
                    (policy / "LICENSE").unlink()
                with self.assertRaises((OSError, ValueError)):
                    scanner.validate_policy(policy)

    def test_verified_download_is_cached_with_license_and_changed_download_refuses(
        self,
    ):
        originals = {
            name: (scanner.POLICY / "rules" / name).read_bytes()
            for name in scanner._RULE_PATHS
        }
        originals["LICENSE"] = (scanner.POLICY / "LICENSE").read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory).resolve() / "cache"
            with patch.object(
                scanner, "download", side_effect=lambda name: originals[name]
            ) as download:
                scanner.prepare_policy(cache)
                self.assertEqual(download.call_count, 9)
            with patch.object(
                scanner,
                "download",
                side_effect=AssertionError("verified cache must scan offline"),
            ):
                scanner.prepare_policy(cache)
            self.assertTrue((cache / "LICENSE").is_file())
            self.assertEqual(cache.stat().st_mode & 0o777, 0o700)
            for entry in cache.rglob("*"):
                self.assertEqual(
                    entry.stat().st_mode & 0o777, 0o700 if entry.is_dir() else 0o600
                )
            (cache / "rules/python/lang/security/audit/eval-detected.yaml").write_bytes(
                b"changed"
            )
            with patch.object(scanner, "download") as download:
                with self.assertRaises(ValueError):
                    scanner.prepare_policy(cache)
                download.assert_not_called()
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(scanner, "download", return_value=b"changed download"),
            self.assertRaises(ValueError),
        ):
            scanner.prepare_policy(Path(directory).resolve() / "cache")

    def test_network_failure_refuses_before_scanning_or_creating_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with (
                patch.object(
                    scanner,
                    "download",
                    side_effect=urllib.error.URLError("synthetic unavailable upstream"),
                ),
                patch.object(scanner.subprocess, "run") as run,
            ):
                with self.assertRaises(OSError):
                    scanner.scan(root=root, policy=root / "cache")
                run.assert_not_called()
            self.assertFalse((root / "semgrep-community.json").exists())
            self.assertFalse((root / "semgrep-community.sarif").exists())

    def test_report_paths_are_ignored_without_hiding_reviewed_policy_or_source(self):
        reports = {
            "semgrep-community.json",
            "semgrep-community.sarif",
            "semgrep-managed.json",
            "semgrep-managed.sarif",
        }
        paths = [
            *sorted(reports),
            ".github/semgrep/policy.json",
            "services/bff/src/routes/sovereign-license.ts",
        ]
        result = subprocess.run(
            ["git", "check-ignore", "--no-index", "--stdin"],
            cwd=scanner.ROOT,
            input="\n".join(paths) + "\n",
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(set(result.stdout.splitlines()), reports)

    def test_unreviewed_manifest_path_or_download_url_and_symlinked_cache_refuse(self):
        manifest = json.loads(scanner.MANIFEST.read_text())
        for changed in ("upstream", "traversal"):
            with (
                self.subTest(changed=changed),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory).resolve()
                copy = json.loads(json.dumps(manifest))
                if changed == "upstream":
                    copy["upstreamRepository"] = "https://unreviewed.example/rules"
                else:
                    key = next(iter(copy["rules"]))
                    copy["rules"]["../outside.yaml"] = copy["rules"].pop(key)
                file = root / "manifest.json"
                file.write_text(json.dumps(copy))
                with patch.object(scanner, "download") as download:
                    with self.assertRaises(ValueError):
                        scanner.prepare_policy(root / "cache", file)
                    download.assert_not_called()
        with self.assertRaises(ValueError):
            scanner.download("https://unreviewed.example/rules")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "cache").symlink_to(scanner.POLICY, target_is_directory=True)
            with self.assertRaises(ValueError):
                scanner.prepare_policy(root / "cache")

    def test_scanner_error_exit_blocks_even_if_old_evidence_exists(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for extension in ("json", "sarif"):
                (root / f"semgrep-community.{extension}").write_text("stale")
            with (
                patch.object(
                    scanner.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess([], 2),
                ),
                self.assertRaises(RuntimeError),
            ):
                scanner.scan(root=root)
            self.assertFalse((root / "semgrep-community.json").exists())
            self.assertFalse((root / "semgrep-community.sarif").exists())

    def test_zero_exit_without_completed_scan_or_sarif_refuses(self):
        cases = (
            None,
            {"version": scanner.VERSION, "errors": [], "paths": {"scanned": []}},
            {
                "version": scanner.VERSION,
                "errors": [{"type": "scanner error"}],
                "paths": {"scanned": ["source.py"]},
            },
            {
                "version": scanner.VERSION,
                "errors": [],
                "paths": {"scanned": ["source.py"]},
            },
        )
        for document in cases:
            with (
                self.subTest(document=document),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory).resolve()

                def incomplete_scan(*_args, document=document, root=root, **_kwargs):
                    if document is not None:
                        (root / "semgrep-community.json").write_text(
                            json.dumps(document)
                        )
                    return subprocess.CompletedProcess([], 0)

                with (
                    patch.object(
                        scanner.subprocess, "run", side_effect=incomplete_scan
                    ),
                    self.assertRaises((OSError, ValueError)),
                ):
                    scanner.scan(root=root)

    def test_scan_reports_are_private_on_success_and_failure(self):
        for exit_code in (0, 2):
            with (
                self.subTest(exit_code=exit_code),
                tempfile.TemporaryDirectory() as tmp,
            ):
                root = Path(tmp)
                outputs = [
                    root / f"semgrep-community.{ext}" for ext in ("json", "sarif")
                ]
                inherited_umasks = []

                def completed_scan(
                    *_args,
                    root=root,
                    outputs=outputs,
                    inherited_umasks=inherited_umasks,
                    exit_code=exit_code,
                    **_kwargs,
                ):
                    current = os.umask(0o077)
                    os.umask(current)
                    inherited_umasks.append(current)
                    outputs[0].write_text(
                        json.dumps(
                            {
                                "version": scanner.VERSION,
                                "errors": [],
                                "paths": {"scanned": ["source.py"]},
                            }
                        )
                    )
                    outputs[1].write_text("SARIF evidence")
                    # Even an explicit scanner-created permissive file is tightened.
                    for output in outputs:
                        output.chmod(0o644)
                    return subprocess.CompletedProcess([], exit_code)

                before = os.umask(0o022)
                try:
                    with patch.object(
                        scanner.subprocess, "run", side_effect=completed_scan
                    ):
                        if exit_code:
                            with self.assertRaises(RuntimeError):
                                scanner.scan(root=root)
                        else:
                            scanner.scan(root=root)
                    restored = os.umask(0o022)
                    self.assertEqual(restored, 0o022)
                    self.assertEqual(inherited_umasks, [0o077])
                    for output in outputs:
                        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
                finally:
                    os.umask(before)

    def test_managed_without_token_reports_unavailability_without_a_scan_or_secret(
        self,
    ):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {}, clear=True),
            patch.object(scanner.subprocess, "run") as run,
            contextlib.redirect_stdout(io.StringIO()) as output,
        ):
            root = Path(directory).resolve()
            for ext in ("json", "sarif"):
                (root / f"semgrep-managed.{ext}").write_text("stale evidence")
            scanner.scan(managed=True, root=root)
            for ext in ("json", "sarif"):
                self.assertFalse((root / f"semgrep-managed.{ext}").exists())
            run.assert_not_called()
            status = json.loads(
                (
                    root / ".axiom-runtime/review/semgrep/managed-policy-status.json"
                ).read_text()
            )
            self.assertEqual(status["managedPolicy"], "unavailable")
            self.assertTrue(status["communityPolicyRequired"])
            self.assertIn("community baseline remains required", output.getvalue())

    def test_unavailable_managed_status_refuses_symlink(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {}, clear=True),
        ):
            root = Path(directory)
            outside = root / "outside.json"
            outside.write_text("protected content")
            status = scanner.private_scan_directory(root) / "managed-policy-status.json"
            status.symlink_to(outside)
            with self.assertRaises(ValueError):
                scanner.scan(managed=True, root=root)
            self.assertEqual(outside.read_text(), "protected content")

    def test_managed_scanner_errors_never_turn_green(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {"SEMGREP_APP_TOKEN": "synthetic-only"}),
            patch.object(
                scanner.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 3),
            ),
            self.assertRaises(RuntimeError),
        ):
            scanner.scan(managed=True, root=Path(directory))

    def test_scanner_terminal_streams_remain_private_on_success_and_failure(self):
        marker = "synthetic-credential-must-not-reach-terminal"
        for exit_code in (0, 2):
            with (
                self.subTest(exit_code=exit_code),
                tempfile.TemporaryDirectory() as tmp,
            ):
                root = Path(tmp)

                def emit(*_args, exit_code=exit_code, root=root, **kwargs):
                    self.assertEqual(kwargs["stderr"], subprocess.STDOUT)
                    kwargs["stdout"].write(marker)
                    (root / "semgrep-community.json").write_text(
                        json.dumps(
                            {
                                "version": scanner.VERSION,
                                "errors": [],
                                "paths": {"scanned": ["source.py"]},
                                "results": [],
                            }
                        )
                    )
                    (root / "semgrep-community.sarif").write_text("clean evidence")
                    return subprocess.CompletedProcess([], exit_code)

                with (
                    patch.object(scanner.subprocess, "run", side_effect=emit),
                    contextlib.redirect_stdout(io.StringIO()) as out,
                    contextlib.redirect_stderr(io.StringIO()) as err,
                ):
                    if exit_code:
                        with self.assertRaises(RuntimeError) as error:
                            scanner.scan(root=root)
                        self.assertNotIn(marker, str(error.exception))
                    else:
                        scanner.scan(root=root)
                self.assertNotIn(marker, out.getvalue() + err.getvalue())
                log = (
                    root / ".axiom-runtime/review/semgrep/semgrep-community.private.log"
                )
                self.assertEqual(log.read_text(), marker)
                self.assertEqual(log.stat().st_mode & 0o777, 0o600)

    def test_managed_findings_withhold_reports_and_block_even_zero_exit(self):
        marker = "synthetic-private-finding"
        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.dict(os.environ, {"SEMGREP_APP_TOKEN": "synthetic-only"}),
        ):
            root = Path(tmp)

            def findings(*_args, **_kwargs):
                (root / "semgrep-managed.json").write_text(
                    json.dumps(
                        {"results": [{"check_id": marker, "extra": {"lines": marker}}]}
                    )
                )
                (root / "semgrep-managed.sarif").write_text(marker)
                return subprocess.CompletedProcess([], 0)

            with (
                patch.object(scanner.subprocess, "run", side_effect=findings),
                self.assertRaises(RuntimeError) as error,
            ):
                scanner.scan(managed=True, root=root)
            self.assertIn("1 finding(s)", str(error.exception))
            self.assertNotIn(marker, str(error.exception))
            for ext in ("json", "sarif"):
                self.assertFalse((root / f"semgrep-managed.{ext}").exists())
                private = (
                    root
                    / f".axiom-runtime/review/semgrep/semgrep-managed.{ext}.private"
                )
                self.assertIn(marker, private.read_text())
                self.assertEqual(private.stat().st_mode & 0o777, 0o600)

    @unittest.skipUnless(
        shutil.which("semgrep"),
        "Pinned Semgrep binary is installed in the mandatory scanning job",
    )
    def test_real_policy_blocks_unsafe_sources_and_accepts_safe_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            unsafe = root / "unsafe"
            safe = root / "safe"
            unsafe.mkdir()
            safe.mkdir()
            (unsafe / "source.py").write_text(
                "import subprocess\npayload = input()\neval(payload)\nexec(payload)\nsubprocess.run(payload, shell=True)\n"
            )
            (unsafe / "source.ts").write_text(
                "import * as cp from 'child_process';\nfunction invoke(command: string) { cp.exec(command); }\nfunction calculate(source: string) { return eval(source); }\nprocess.env['NODE_TLS_REJECT_UNAUTHORIZED'] = 0;\n"
            )
            credential = "AKIA" + "ABCDEFGHIJKLMNOP"
            key = subprocess.run(
                ["openssl", "genpkey", "-algorithm", "ED25519"],
                capture_output=True,
                text=True,
                check=True,
            ).stdout
            (unsafe / "credential.txt").write_text(credential + "\n" + key)
            (safe / "source.py").write_text(
                "import ast, subprocess\npayload = input()\nast.literal_eval(payload)\nsubprocess.run(['echo', payload], shell=False)\n"
            )
            (safe / "source.ts").write_text(
                "import * as cp from 'child_process';\nfunction invoke(command: string) { cp.execFile('/bin/echo', [command]); }\nfunction calculate(source: string) { return JSON.parse(source); }\n"
            )
            base = [
                "semgrep",
                "scan",
                "--config",
                str(scanner.POLICY / "rules"),
                "--error",
                "--strict",
                "--metrics=off",
                "--disable-version-check",
                "--json",
            ]
            unsafe_scan = subprocess.run(
                [*base, str(unsafe)],
                cwd=root,
                check=False,
                capture_output=True,
                text=True,
                timeout=120,
            )
            self.assertEqual(unsafe_scan.returncode, 1, unsafe_scan.stderr)
            unsafe_report = json.loads(unsafe_scan.stdout)
            detected = {
                result["check_id"].rsplit(".", 1)[-1]
                for result in unsafe_report["results"]
            }
            self.assertEqual(
                detected,
                {
                    "eval-detected",
                    "exec-detected",
                    "subprocess-shell-true",
                    "detect-child-process",
                    "bypass-tls-verification",
                    "detected-private-key",
                    "detected-aws-access-key-id-value",
                },
            )
            self.assertEqual(unsafe_report["errors"], [])
            self.assertTrue(
                any(
                    "browser" in result["check_id"]
                    for result in unsafe_report["results"]
                )
            )
            self.assertTrue(
                any(
                    "python" in result["check_id"]
                    for result in unsafe_report["results"]
                )
            )
            safe_scan = subprocess.run(
                [*base, str(safe)],
                cwd=root,
                check=False,
                capture_output=True,
                text=True,
                timeout=120,
            )
            self.assertEqual(safe_scan.returncode, 0, safe_scan.stderr)
            self.assertEqual(json.loads(safe_scan.stdout)["results"], [])
            # Exercise the actual workflow runner too: findings must block,
            # while safe source must produce completed JSON and SARIF evidence.
            with (
                contextlib.redirect_stdout(io.StringIO()) as out,
                contextlib.redirect_stderr(io.StringIO()) as err,
            ):
                with self.assertRaises(RuntimeError) as error:
                    scanner.scan(root=unsafe)
                scanner.scan(root=safe)
            self.assertNotIn(
                credential, out.getvalue() + err.getvalue() + str(error.exception)
            )
            self.assertIn("finding(s)", str(error.exception))
            for ext in ("json", "sarif"):
                self.assertFalse((unsafe / f"semgrep-community.{ext}").exists())
                private = (
                    unsafe
                    / f".axiom-runtime/review/semgrep/semgrep-community.{ext}.private"
                )
                if ext == "sarif":
                    self.assertIn(credential, private.read_text())
                else:
                    self.assertEqual(len(json.loads(private.read_text())["results"]), 8)
                self.assertEqual(private.stat().st_mode & 0o777, 0o600)
            self.assertTrue((safe / "semgrep-community.sarif").is_file())


if __name__ == "__main__":
    unittest.main()
