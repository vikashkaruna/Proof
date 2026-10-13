"""Fresh-process first-PDF mode and existing warmed provider acceptance contracts."""

import copy
import importlib.util
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
HARNESS = (ROOT / "scripts/test-evidence-storage.py").read_text()
WARMUP = (ROOT / "scripts/warm-pdf-renderer.ts").read_text()
spec = importlib.util.spec_from_file_location(
    "evidence_storage_harness", ROOT / "scripts/test-evidence-storage.py"
)
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


def measurement():
    return {
        "scope": "fresh-process-first-artifact-request",
        "artifactRequestElapsedMs": 312.75,
        "pdfBytes": 1024,
        "pdfSha256": "a" * 64,
        "downloadSha256": "a" * 64,
        "pdfCreator": "Chromium",
        "requiredChromiumSourcePath": True,
        "osDiskCacheCold": "unverified",
        "remoteNfr": "unverified",
        "productionTimeoutChanged": False,
    }


class EvidenceStorageHarnessTests(unittest.TestCase):
    def run_cold(
        self,
        stats=None,
        proof=None,
        *,
        returncode=0,
        running=True,
        label="owned",
        emit=True,
        emit_report=True,
    ):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "runtime.env").write_text("SYNTHETIC_FIXTURE=true\n")
            (directory / "private-cold-pdf-measurement.json").write_text(
                json.dumps(measurement())
            )
            (directory / "private-cold-playwright.json").write_text(
                json.dumps(
                    {
                        "stats": {
                            "expected": 1,
                            "unexpected": 0,
                            "flaky": 0,
                            "skipped": 0,
                        }
                    }
                )
            )
            info = {
                "Config": {"Labels": {"axiom.fixture.run": label}},
                "State": {"Running": running},
            }

            def execute(argv, **kwargs):
                self.assertNotIn("scripts/warm-pdf-renderer.ts", argv)
                self.assertIn("--workers=1", argv)
                self.assertIn("--retries=0", argv)
                self.assertEqual(argv.count("board-reports-provider.spec.ts"), 1)
                self.assertIn("--grep", argv)
                self.assertEqual(kwargs["env"]["AXIOM_COLD_PDF_ACCEPTANCE"], "true")
                if emit_report:
                    Path(kwargs["env"]["PLAYWRIGHT_JSON_OUTPUT_FILE"]).write_text(
                        json.dumps(
                            {
                                "stats": stats
                                or {
                                    "expected": 1,
                                    "unexpected": 0,
                                    "flaky": 0,
                                    "skipped": 0,
                                }
                            }
                        )
                    )
                if emit:
                    (directory / "private-cold-pdf-measurement.json").write_text(
                        json.dumps(proof if proof is not None else measurement())
                    )
                return subprocess.CompletedProcess(argv, returncode)

            with (
                patch.object(
                    harness.sys,
                    "argv",
                    ["harness", "--cold-pdf", "--directory", str(directory)],
                ),
                patch.object(
                    harness, "owned_provider", return_value=({"runId": "owned"}, info)
                ),
                patch.object(harness, "resume_provider"),
                patch.object(harness, "command", return_value="synthetic-revision"),
                patch.object(harness.subprocess, "run", side_effect=execute) as run,
            ):
                harness.main()
            self.assertEqual(run.call_count, 1)
            self.assertFalse((directory / "private-cold-pdf-measurement.json").exists())
            self.assertFalse((directory / "private-cold-playwright.json").exists())
            return json.loads((directory / "cold-pdf-results.json").read_text())

    def test_cold_mode_uses_one_unwarmed_owned_first_journey(self):
        self.assertEqual(self.run_cold()["measurement"], measurement())

    def test_stale_measurement_cannot_pass_a_missing_new_measurement(self):
        with self.assertRaises(FileNotFoundError):
            self.run_cold(emit=False)

    def test_stale_playwright_report_cannot_substitute_for_new_execution(self):
        with self.assertRaises(FileNotFoundError):
            self.run_cold(emit_report=False)

    def test_missing_skipped_flaky_extra_or_failed_journey_refused(self):
        for key, value in [
            ("expected", 0),
            ("expected", 2),
            ("expected", True),
            ("skipped", 1),
            ("flaky", 1),
            ("unexpected", 1),
        ]:
            stats = {"expected": 1, "unexpected": 0, "flaky": 0, "skipped": 0}
            stats[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(RuntimeError):
                self.run_cold(stats=stats)
        with self.assertRaises(RuntimeError):
            self.run_cold(returncode=1)

    def test_foreign_or_stopped_provider_refused_before_launch(self):
        for values in [{"label": "foreign"}, {"running": False}]:
            with self.subTest(values=values), self.assertRaises(RuntimeError):
                self.run_cold(**values)

    def test_malformed_or_overstated_measurements_refused(self):
        for key, value in [
            ("artifactRequestElapsedMs", True),
            ("artifactRequestElapsedMs", -1),
            ("artifactRequestElapsedMs", float("nan")),
            ("artifactRequestElapsedMs", float("inf")),
            ("pdfBytes", 499),
            ("pdfBytes", True),
            ("pdfSha256", "Z" * 64),
            ("downloadSha256", "b" * 64),
            ("pdfCreator", "deterministic-fallback"),
            ("requiredChromiumSourcePath", False),
            ("osDiskCacheCold", True),
            ("remoteNfr", "passed"),
            ("productionTimeoutChanged", True),
        ]:
            proof = copy.deepcopy(measurement())
            proof[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(RuntimeError):
                harness.validate_cold_pdf_measurement(proof)
        for proof in [None, {}, {**measurement(), "extra": True}]:
            with self.assertRaises(RuntimeError):
                harness.validate_cold_pdf_measurement(proof)

    def test_existing_warmup_and_full_suite_remain_separate(self):
        browser = HARNESS[HARNESS.index("if args.browser or args.cold_pdf:") :]
        warm = browser.index("scripts/warm-pdf-renderer.ts")
        self.assertLess(warm, browser.index('"playwright"'))
        self.assertIn("if not args.cold_pdf:", browser[:warm])
        self.assertIn("expected_browser_tests = 1 if args.cold_pdf else 16", browser)
        self.assertIn("check=True", browser[warm : warm + 230])

    def test_existing_warmup_budget_and_strict_renderer_unchanged(self):
        attempt_ms = int(
            re.search(r"timeoutMs:\s*([\d_]+)", WARMUP).group(1).replace("_", "")
        )
        limit_s = int(
            re.search(
                r'scripts/warm-pdf-renderer\.ts"\][^)]*timeout=(\d+)',
                HARNESS,
                re.DOTALL,
            ).group(1)
        )
        self.assertLess(2 * attempt_ms / 1000, limit_s)
        self.assertIn("requireChromium: true", WARMUP)
        self.assertIn("process.exit(1)", WARMUP)

    def test_hosted_cold_mode_precedes_warm_suite_and_owns_fresh_servers(self):
        ci = (ROOT / ".github/workflows/ci.yml").read_text()
        self.assertLess(
            ci.index("scripts/test-evidence-storage.py --cold-pdf"),
            ci.index("scripts/test-evidence-storage.py --browser"),
        )
        config = (ROOT / "tests/e2e/playwright.config.ts").read_text()
        self.assertEqual(config.count("reuseExistingServer: false"), 3)


if __name__ == "__main__":
    unittest.main()
