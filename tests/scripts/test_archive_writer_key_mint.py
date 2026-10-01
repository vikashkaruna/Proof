"""The BFF archive JWT must be a distinct signed PostgREST role credential."""

import base64
import hashlib
import hmac
import json
import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def decode_part(part: str) -> dict:
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))


class ArchiveWriterMintTests(unittest.TestCase):
    def test_compose_writer_secret_is_bff_only(self):
        for path in ("docker-compose.yml", "infra/docker/docker-compose.staging.yml",
                     "infra/docker/docker-compose.preprod.yml",
                     "infra/docker/docker-compose.onprem.yml"):
            with self.subTest(path=path):
                source = (ROOT / path).read_text()
                services = re.split(r"(?m)^  ([a-z][a-z0-9-]*):\s*$", source)
                # Compose accepts `- KEY=value` and `KEY: value`; match an assignment at
                # the start of a line, not a `${KEY:?...}` reference inside a value.
                assigned = re.compile(r"(?m)^\s*(?:-\s*)?SUPABASE_ARCHIVE_WRITER_KEY\s*[=:]")
                owners = [name for name, body in zip(services[1::2], services[2::2])
                          if assigned.search(body)]
                self.assertEqual(owners, ["bff"])

    def test_container_acceptance_keeps_writer_out_of_web_and_target(self):
        source = (ROOT / "scripts/test-deployed-http.sh").read_text()
        self.assertIn("('approval_archive_writer','SUPABASE_ARCHIVE_WRITER_KEY')", source)
        self.assertIn("('human_action_writer','SUPABASE_HUMAN_ACTION_WRITER_KEY')", source)
        self.assertIn("('agent_ledger_writer','SUPABASE_AGENT_LEDGER_WRITER_KEY')", source)
        self.assertIn("'JWT_SECRET'", source)
        # 0099: the archive writer keeps release only; its probe reaches the founder gate.
        self.assertIn("founder_authority_required", source)
        self.assertIn("record_approval_export", source)
        self.assertNotIn("'archiveWriterKey':", source)
        self.assertNotIn("'SUPABASE_ARCHIVE_WRITER_KEY' for k", source)

    def test_browser_acceptance_receives_writer_key_for_playwright(self):
        # Deployed Playwright (config + global setup) throws without this key
        # in its own process env; the container env file alone is not enough.
        source = (ROOT / "scripts/test-deployed-http.sh").read_text()
        self.assertRegex(
            source,
            r'SUPABASE_ARCHIVE_WRITER_KEY="\$archive_writer_key" \\\n\s+'
            r'SUPABASE_HUMAN_ACTION_WRITER_KEY="\$human_writer_key" \\\n\s+'
            r'SUPABASE_EVIDENCE_INGESTION_WRITER_KEY="\$evidence_writer_key" \\\n\s+'
            r'\./scripts/run-deployed-acceptance\.sh "\$state_dir/\$environment\.json"\n',
        )
        # The API-only path runs the same strict-parity script, which registers
        # workload identities through the human writer; without the key it 401s.
        self.assertRegex(
            source,
            r'SUPABASE_HUMAN_ACTION_WRITER_KEY="\$human_writer_key" \\\n\s+'
            r'SUPABASE_EVIDENCE_INGESTION_WRITER_KEY="\$evidence_writer_key" \\\n\s+'
            r'\./scripts/run-deployed-acceptance\.sh "\$state_dir/\$environment\.json" api-only',
        )
        self.assertIn("SUPABASE_ARCHIVE_WRITER_KEY=//p' \"$state_dir/$environment.env\"", source)
        config = (ROOT / "tests/e2e/playwright.config.ts").read_text()
        self.assertIn("requires a BFF-only SUPABASE_ARCHIVE_WRITER_KEY", config)

    def test_minted_writer_is_signed_and_distinct_from_shared_service_role(self):
        result = subprocess.run(
            ["node", "scripts/mint-supabase-keys.mjs", "--env", "test"],
            cwd=ROOT, capture_output=True, text=True, check=True, timeout=10,
        )
        values = dict(line.split("=", 1) for line in result.stdout.splitlines()
                      if line.startswith(("SUPABASE_JWT_SECRET=", "SUPABASE_SERVICE_KEY=", "SUPABASE_ARCHIVE_WRITER_KEY=")))
        writer = values["SUPABASE_ARCHIVE_WRITER_KEY"]
        self.assertNotEqual(writer, values["SUPABASE_SERVICE_KEY"])
        header, payload, signature = writer.split(".")
        self.assertEqual(decode_part(payload)["role"], "approval_archive_writer")
        digest = hmac.new(values["SUPABASE_JWT_SECRET"].encode(),
                          f"{header}.{payload}".encode(), hashlib.sha256).digest()
        expected = base64.urlsafe_b64encode(digest).decode().rstrip("=")
        self.assertTrue(hmac.compare_digest(signature, expected))


if __name__ == "__main__":
    unittest.main()
