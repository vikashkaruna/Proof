"""Fresh-process first-PDF mode and existing warmed provider acceptance contracts."""

import copy
import importlib.util
import json
import os
import re
import stat
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
    def creation_intent(self, directory):
        run_id = "0123456789ab"
        return {
            "schemaVersion": 1,
            "runId": run_id,
            "name": "axiom-evidence-" + run_id,
            "volume": "axiom-evidence-" + run_id + "-data",
            "sourceImageId": "sha256:" + "a" * 64,
            "sourceWorktree": str(harness.ROOT.resolve()),
            "sourceCommit": harness.COMMIT,
            "sourceArchiveSha256": harness.ARCHIVE_SHA,
        }

    def write_intent(self, directory):
        intent = self.creation_intent(directory)
        path = directory / "private-creation-intent.json"
        path.write_text(json.dumps(intent))
        path.chmod(0o600)
        return intent

    def absent(self, argv):
        raise subprocess.CalledProcessError(
            1, argv, output=f"Error: No such {argv[1]}: {argv[-1]}"
        )

    def test_interrupted_volume_only_stop_uses_durable_intent_without_state(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            intent = self.write_intent(directory)
            removed = []

            def docker(argv, **_):
                if argv[1:3] == ["container", "inspect"]:
                    return self.absent(argv)
                if argv[1:3] == ["volume", "inspect"]:
                    return json.dumps(
                        [
                            {
                                "Name": intent["volume"],
                                "Labels": harness.creation_labels(intent),
                            }
                        ]
                    )
                removed.append(argv)
                return ""

            with (
                patch.object(
                    harness.sys, "argv", ["harness", "--stop", "--directory", raw]
                ),
                patch.object(harness, "command", side_effect=docker),
            ):
                harness.main()
            self.assertEqual(removed, [["docker", "volume", "rm", intent["volume"]]])
            self.assertFalse((directory / "private-creation-intent.json").exists())

    def test_intent_is_exclusive_private_and_fsynced_before_creation(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            with (
                patch.object(harness, "command", side_effect=self.absent),
                patch.object(harness.os, "fsync", wraps=os.fsync) as sync,
            ):
                intent = harness.prepare_creation_intent(
                    directory, "0123456789ab", "sha256:" + "a" * 64
                )
            path = directory / "private-creation-intent.json"
            self.assertEqual(json.loads(path.read_text()), intent)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertGreaterEqual(sync.call_count, 3)
            original = path.read_bytes()
            with (
                patch.object(harness, "command", side_effect=self.absent),
                self.assertRaises(FileExistsError),
            ):
                harness.prepare_creation_intent(
                    directory, "0123456789ab", "sha256:" + "a" * 64
                )
            self.assertEqual(path.read_bytes(), original)

    def test_preexisting_container_or_volume_refused_without_creation(self):
        for kind in ["container", "volume"]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as raw:
                directory = Path(raw)
                calls = []

                def docker(argv, *, kind=kind, calls=calls, **_):
                    calls.append(argv)
                    if argv[1] == kind:
                        return json.dumps([{"Name": "preexisting"}])
                    return self.absent(argv)

                with (
                    patch.object(harness, "command", side_effect=docker),
                    self.assertRaisesRegex(RuntimeError, "Preexisting"),
                ):
                    harness.prepare_creation_intent(
                        directory, "0123456789ab", "sha256:" + "a" * 64
                    )
                self.assertFalse((directory / "private-creation-intent.json").exists())
                self.assertTrue(all(call[2] == "inspect" for call in calls))

    def test_foreign_volume_or_container_refused_before_any_removal(self):
        for kind in ["container", "volume"]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as raw:
                directory = Path(raw)
                intent = self.write_intent(directory)
                calls = []

                def docker(argv, *, kind=kind, calls=calls, intent=intent, **_):
                    calls.append(argv)
                    if argv[1:3] == ["container", "inspect"]:
                        return json.dumps(
                            [
                                {
                                    "Id": "c" * 64,
                                    "Name": "/" + intent["name"],
                                    "Image": intent["sourceImageId"],
                                    "Config": {
                                        "Labels": {}
                                        if kind == "container"
                                        else harness.creation_labels(intent)
                                    },
                                    "State": {"Paused": False},
                                    "Mounts": [
                                        {
                                            "Type": "volume",
                                            "Name": intent["volume"],
                                            "Destination": "/data",
                                        }
                                    ],
                                }
                            ]
                        )
                    return json.dumps(
                        [
                            {
                                "Name": intent["volume"],
                                "Labels": {}
                                if kind == "volume"
                                else harness.creation_labels(intent),
                            }
                        ]
                    )

                with (
                    patch.object(harness, "command", side_effect=docker),
                    self.assertRaisesRegex(RuntimeError, "ownership"),
                ):
                    harness.cleanup_creation_intent(directory)
                self.assertTrue(all(call[2] == "inspect" for call in calls))
                self.assertTrue((directory / "private-creation-intent.json").exists())

    def test_invalid_intent_permissions_symlink_hardlink_or_source_refused(self):
        for kind in ["permissions", "symlink", "hardlink", "source", "image"]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as raw:
                directory = Path(raw)
                intent = self.write_intent(directory)
                path = directory / "private-creation-intent.json"
                if kind == "permissions":
                    path.chmod(0o644)
                elif kind == "symlink":
                    other = directory / "other"
                    path.rename(other)
                    path.symlink_to(other)
                elif kind == "hardlink":
                    os.link(path, directory / "other")
                else:
                    intent[
                        "sourceWorktree" if kind == "source" else "sourceImageId"
                    ] = "foreign"
                    path.write_text(json.dumps(intent))
                with (
                    patch.object(harness, "command") as docker,
                    self.assertRaises((RuntimeError, OSError)),
                ):
                    harness.cleanup_creation_intent(directory)
                docker.assert_not_called()

    def test_owned_interrupted_container_is_removed_by_full_id_not_name(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            intent = self.write_intent(directory)
            mutations = []
            container = {
                "Id": "c" * 64,
                "Name": "/" + intent["name"],
                "Image": intent["sourceImageId"],
                "Config": {"Labels": harness.creation_labels(intent)},
                "State": {"Paused": True},
                "Mounts": [
                    {"Type": "volume", "Name": intent["volume"], "Destination": "/data"}
                ],
            }
            volume = {
                "Name": intent["volume"],
                "Labels": harness.creation_labels(intent),
            }

            def docker(argv, **_):
                if argv[1:3] == ["container", "inspect"]:
                    return json.dumps([container])
                if argv[1:3] == ["volume", "inspect"]:
                    return json.dumps([volume])
                mutations.append(argv)
                return ""

            with patch.object(harness, "command", side_effect=docker):
                harness.cleanup_creation_intent(directory)
            self.assertEqual(
                mutations,
                [
                    ["docker", "unpause", "c" * 64],
                    ["docker", "rm", "-f", "c" * 64],
                    ["docker", "volume", "rm", intent["volume"]],
                ],
            )

    def test_inspection_failure_is_not_absence_and_empty_array_absence_is_recognized(
        self,
    ):
        name = "axiom-evidence-0123456789ab"
        for output in [
            "permission denied",
            "Cannot connect to Docker",
            "[]\nError: No such container: foreign",
        ]:
            with (
                self.subTest(output=output),
                patch.object(
                    harness,
                    "command",
                    side_effect=subprocess.CalledProcessError(
                        1, ["docker"], output=output
                    ),
                ),
                self.assertRaisesRegex(RuntimeError, "inspection failed"),
            ):
                harness.inspect_optional("container", name)
        with patch.object(
            harness,
            "command",
            side_effect=subprocess.CalledProcessError(
                1, ["docker"], output=f"[]\nError: No such container: {name}"
            ),
        ):
            self.assertIsNone(harness.inspect_optional("container", name))

    def test_provider_volume_creation_observes_fsynced_intent_and_exact_labels(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            volume = None
            calls = []
            image = "sha256:" + "a" * 64

            def docker(argv, **_):
                nonlocal volume
                calls.append(argv)
                if argv[1:3] == ["image", "inspect"]:
                    return json.dumps(
                        [
                            {
                                "Id": image,
                                "Config": {
                                    "Labels": {
                                        "axiom.fixture.source": harness.COMMIT,
                                        "axiom.fixture.archive": harness.ARCHIVE_SHA,
                                    }
                                },
                            }
                        ]
                    )
                if argv[1:3] == ["volume", "create"]:
                    intent = harness.read_creation_intent(directory)
                    self.assertEqual(intent["sourceImageId"], image)
                    self.assertFalse((directory / "private-fixture.json").exists())
                    self.assertGreaterEqual(sync.call_count, 3)
                    for key, value in harness.creation_labels(intent).items():
                        self.assertIn(f"{key}={value}", argv)
                    volume = {
                        "Name": intent["volume"],
                        "Labels": harness.creation_labels(intent),
                    }
                    raise RuntimeError("Synthetic interrupted provider creation")
                if argv[1:3] == ["volume", "inspect"] and volume:
                    return json.dumps([volume])
                if argv[1:3] == ["volume", "rm"]:
                    return ""
                return self.absent(argv)

            with (
                patch.object(
                    harness.sys,
                    "argv",
                    ["harness", "--directory", raw, "--image-id", image],
                ),
                patch.object(harness, "command", side_effect=docker),
                patch.object(harness.os, "fsync", wraps=os.fsync) as sync,
                self.assertRaisesRegex(RuntimeError, "Synthetic interrupted"),
            ):
                harness.main()
            self.assertTrue(any(call[1:3] == ["volume", "rm"] for call in calls))
            self.assertFalse((directory / "private-creation-intent.json").exists())

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
        browser = HARNESS[
            HARNESS.index("if args.browser or args.cold_pdf or args.custody_browser:") :
        ]
        warm = browser.index("scripts/warm-pdf-renderer.ts")
        self.assertLess(warm, browser.index('"playwright"'))
        self.assertIn(
            "if not args.cold_pdf and not args.custody_browser:", browser[:warm]
        )
        self.assertIn("expected_browser_tests = 1 if args.cold_pdf else 16", browser)
        self.assertIn("check=True", browser[warm : warm + 230])

    def run_custody(self, stats=None, returncode=0):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            (directory / "runtime.env").write_text("SYNTHETIC_FIXTURE=true\n")
            observed = []

            def execute(argv, **kwargs):
                observed.append(argv)
                self.assertNotIn("scripts/warm-pdf-renderer.ts", argv)
                self.assertIn("local-custody-policy-provider.spec.ts", argv)
                self.assertNotIn("board-reports-provider.spec.ts", argv)
                self.assertIn("--retries=0", argv)
                self.assertEqual(kwargs["timeout"], 1800)
                self.assertEqual(
                    kwargs["env"]["AXIOM_LOCAL_CUSTODY_BROWSER_ACCEPTANCE"], "true"
                )
                Path(kwargs["env"]["PLAYWRIGHT_JSON_OUTPUT_FILE"]).write_text(
                    json.dumps(
                        {
                            "stats": stats
                            or {
                                "expected": 4,
                                "unexpected": 0,
                                "flaky": 0,
                                "skipped": 0,
                            }
                        }
                    )
                )
                return subprocess.CompletedProcess(argv, returncode)

            info = {
                "Config": {"Labels": {"axiom.fixture.run": "owned"}},
                "State": {"Running": True},
            }
            with (
                patch.object(
                    harness.sys,
                    "argv",
                    ["harness", "--custody-browser", "--directory", str(directory)],
                ),
                patch.object(
                    harness, "owned_provider", return_value=({"runId": "owned"}, info)
                ),
                patch.object(harness, "resume_provider"),
                patch.object(harness, "command", return_value="synthetic"),
                patch.object(harness.subprocess, "run", side_effect=execute),
            ):
                try:
                    harness.main()
                except RuntimeError:
                    self.assertTrue(
                        (directory / "private-custody-playwright.json").is_file()
                    )
                    self.assertEqual(
                        json.loads(
                            (directory / "custody-browser-results.json").read_text()
                        )["status"],
                        "failed",
                    )
                    raise
            self.assertEqual(len(observed), 1)
            self.assertFalse((directory / "private-custody-playwright.json").exists())
            self.assertFalse((directory / "browser-results.json").exists())
            self.assertFalse((directory / "cold-pdf-results.json").exists())
            return json.loads((directory / "custody-browser-results.json").read_text())

    def test_custody_is_four_strict_separate_cases_not_replacement_for16_or_cold1(self):
        proof = self.run_custody()
        self.assertEqual(
            proof["counts"], {"expected": 4, "unexpected": 0, "flaky": 0, "skipped": 0}
        )
        self.assertEqual(proof["limits"]["perCaseTimeoutMs"], 120000)
        self.assertEqual(proof["limits"]["keyProvisioning"], "not_exercised")
        for key, value in [
            ("expected", 0),
            ("expected", 3),
            ("expected", 5),
            ("expected", True),
            ("unexpected", 1),
            ("flaky", 1),
            ("skipped", 1),
        ]:
            counts = {"expected": 4, "unexpected": 0, "flaky": 0, "skipped": 0}
            counts[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(RuntimeError):
                self.run_custody(stats=counts)
        with self.assertRaises(RuntimeError):
            self.run_custody(returncode=1)

    def test_custody_serial_inventory_and_original_case_budgets(self):
        source = (
            ROOT / "tests/e2e/tests/local-custody-policy-provider.spec.ts"
        ).read_text()
        self.assertEqual(len(re.findall(r"^\s+test\('", source, re.MULTILINE)), 4)
        self.assertIn("test.describe.serial", source)
        self.assertNotIn("test.setTimeout", source)
        self.assertNotIn("test.skip", source)
        self.assertNotIn(".fulfill(", source)
        self.assertIn("await intercepted.fetch()", source)
        self.assertIn("await intercepted.abort('failed')", source)
        self.assertIn("withFreshMfaFixtureCounter", source)
        config = (ROOT / "tests/e2e/playwright.config.ts").read_text()
        self.assertIn("AXIOM_LOCAL_CUSTODY_BROWSER_ACCEPTANCE", config)
        self.assertIn("timeout: 120_000", config)
        self.assertIn("globalTimeout: acceptanceTarget ? 10 * 60_000", config)

    def test_custody_checks_owned_parity_before_privileged_setup(self):
        source = (
            ROOT / "tests/e2e/tests/local-custody-policy-provider.spec.ts"
        ).read_text()
        self.assertIn(
            "assertOwnedFixture();", source.split("async function fixturePost")[0]
        )
        post = source.split("async function fixturePost", 1)[1].split(
            "async function signIn", 1
        )[0]
        self.assertLess(post.index("requireOwnedLocal();"), post.index("await fetch("))
        self.assertRegex(
            source, r"requireOwnedLocal\(\);\s+const who = await createMfaAccount"
        )
        helper = (ROOT / "scripts/lib/acceptance-local-custody-browser.ts").read_text()
        self.assertIn("load: typeof loadParityFixture = loadParityFixture", helper)
        self.assertIn("const fixture = load(root);", helper)

    def test_custody_reload_and_positive_recovery_do_not_auto_post(self):
        source = (
            ROOT / "tests/e2e/tests/local-custody-policy-provider.spec.ts"
        ).read_text()
        self.assertIn("owner.page.on('request', countCustodyPosts)", source)
        self.assertIn("expect(custodyPosts).toBe(0)", source)
        self.assertEqual(
            source.count("expect(custodyPosts).toBe(postsBeforeReload)"), 1
        )
        self.assertIn("request.method() === 'POST'", source)
        self.assertIn("expect(custodyPosts).toBe(postsBeforeReload + 1)", source)
        self.assertIn("custodyRecoveries.slice(recoveriesBeforeCheck)", source)
        self.assertIn("body: { resolution }", source)

    def test_original16_mode_does_not_enable_or_select_custody(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            (directory / "runtime.env").write_text(
                "AXIOM_LOCAL_CUSTODY_BROWSER_ACCEPTANCE=true\n"
            )
            runs = []

            def execute(argv, **kwargs):
                runs.append(argv)
                self.assertNotIn(
                    "AXIOM_LOCAL_CUSTODY_BROWSER_ACCEPTANCE", kwargs["env"]
                )
                if "scripts/warm-pdf-renderer.ts" in argv:
                    self.assertEqual(kwargs["timeout"], 300)
                else:
                    self.assertNotIn("local-custody-policy-provider.spec.ts", argv)
                    self.assertEqual(sum(v.endswith(".spec.ts") for v in argv), 7)
                    self.assertIn("--retries=0", argv)
                    Path(kwargs["env"]["PLAYWRIGHT_JSON_OUTPUT_FILE"]).write_text(
                        json.dumps(
                            {
                                "stats": {
                                    "expected": 16,
                                    "unexpected": 0,
                                    "flaky": 0,
                                    "skipped": 0,
                                }
                            }
                        )
                    )
                return subprocess.CompletedProcess(argv, 0)

            info = {
                "Config": {"Labels": {"axiom.fixture.run": "owned"}},
                "State": {"Running": True},
            }
            with (
                patch.object(
                    harness.sys,
                    "argv",
                    ["harness", "--browser", "--directory", str(directory)],
                ),
                patch.object(
                    harness, "owned_provider", return_value=({"runId": "owned"}, info)
                ),
                patch.object(harness, "resume_provider"),
                patch.object(harness, "command", return_value="synthetic"),
                patch.object(harness.subprocess, "run", side_effect=execute),
            ):
                harness.main()
            self.assertEqual(len(runs), 2)
            self.assertEqual(
                json.loads((directory / "browser-results.json").read_text())["counts"],
                {"expected": 16, "unexpected": 0, "flaky": 0, "skipped": 0},
            )

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
