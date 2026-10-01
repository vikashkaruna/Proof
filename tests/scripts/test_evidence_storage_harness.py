"""The provider browser harness warms the PDF renderer before any journey runs.

Cold headless Chromium on a fresh CI runner can exceed the renderer's 30 s
budget; unwarmed, that surfaced mid-suite as a 503 or a reset connection on
whichever journey built the first PDF. The warm-up must run before Playwright
and must fit its own two renderer attempts inside the subprocess limit.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HARNESS = (ROOT / "scripts/test-evidence-storage.py").read_text()
WARMUP = (ROOT / "scripts/warm-pdf-renderer.ts").read_text()


class EvidenceStorageHarnessTests(unittest.TestCase):
    def test_warm_up_runs_before_playwright_in_browser_mode(self):
        browser = HARNESS[HARNESS.index("if args.browser:") :]
        warm = browser.index("scripts/warm-pdf-renderer.ts")
        playwright = browser.index('"playwright"')
        self.assertLess(warm, playwright)
        # A failed warm-up must stop the run, not be ignored.
        call = browser[browser.rindex("subprocess.run(", 0, warm) : warm + 200]
        self.assertIn("check=True", call)

    def test_two_renderer_attempts_fit_the_subprocess_limit(self):
        attempt_ms = int(re.search(r"timeoutMs:\s*([\d_]+)", WARMUP).group(1).replace("_", ""))
        limit_s = int(
            re.search(
                r'scripts/warm-pdf-renderer\.ts"\][^)]*timeout=(\d+)', HARNESS, re.S
            ).group(1)
        )
        # renderHtmlToPdf retries once in a second headless mode.
        self.assertLess(2 * attempt_ms / 1000, limit_s)

    def test_warm_up_demands_chromium_and_reports_failure(self):
        self.assertIn("requireChromium: true", WARMUP)
        self.assertIn("process.exit(1)", WARMUP)


if __name__ == "__main__":
    unittest.main()
