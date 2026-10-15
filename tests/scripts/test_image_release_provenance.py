"""Execute the real publisher shell against a host-only fake Docker CLI."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SHA = "a" * 40
COMPONENTS = ("web", "marketing", "bff", "agent-runtime", "model-gateway", "temporal-worker")


def publisher_shell():
    lines = (ROOT / ".github/workflows/ci.yml").read_text().splitlines()
    start = lines.index("      - name: Build and push")
    if lines[start + 1] != "        run: |":
        raise ValueError("Expected publisher run block")
    body = []
    for line in lines[start + 2:]:
        if line and not line.startswith("          "):
            break
        body.append(line[10:])
    return "\n".join(body).replace("${{ github.sha }}", SHA).replace(
        "${{ github.repository_owner }}", "AxiomOwner"
    )


class ImageReleaseProvenanceTests(unittest.TestCase):
    def run_publisher(self, mismatch="", sha=SHA, mismatch_component="web"):
        with tempfile.TemporaryDirectory(prefix="axiom-publisher-test-") as directory:
            root = Path(directory)
            fake = root / "docker"
            fake.write_text(
                f"#!{sys.executable}\n"
                "import json, os, sys\n"
                "from pathlib import Path\n"
                "args=sys.argv[1:]\n"
                "with Path(os.environ['PUBLISHER_CALLS']).open('a') as log:\n"
                " log.write(json.dumps(args)+'\\n')\n"
                "if args[:2]==['image','inspect']:\n"
                " sha=os.environ['GITHUB_SHA']\n"
                " mismatch=os.environ.get('PUBLISHER_MISMATCH','') if '/axiom-'+os.environ['PUBLISHER_MISMATCH_COMPONENT']+':' in args[2] else ''\n"
                " env=[] if mismatch=='missing-env' else ['AXIOM_RELEASE_SHA='+('b'*40 if mismatch=='env' else sha)]\n"
                " label='b'*40 if mismatch=='label' else sha\n"
                " print(json.dumps([{'Config':{'Env':env,'Labels':{'org.opencontainers.image.revision':label}}}]))\n"
            )
            fake.chmod(0o700)
            log = root / "calls.jsonl"
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ["PATH"],
                       GITHUB_SHA=sha, GITHUB_REPOSITORY_OWNER="AxiomOwner",
                       PUBLISHER_CALLS=str(log), PUBLISHER_MISMATCH=mismatch,
                       PUBLISHER_MISMATCH_COMPONENT=mismatch_component)
            result = subprocess.run(
                ["bash", "-e", "-o", "pipefail", "-c", publisher_shell()],
                cwd=ROOT, env=env, capture_output=True, text=True, timeout=30,
            )
            calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            return result, calls

    def test_all_six_images_are_bound_and_verified_before_push(self):
        result, calls = self.run_publisher()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 18)
        for index, component in enumerate(COMPONENTS):
            build, inspect, push = calls[index * 3:index * 3 + 3]
            image = f"ghcr.io/axiomowner/axiom-{component}:{SHA}"
            self.assertEqual(build[:3], ["buildx", "build", "--load"])
            self.assertEqual(build[build.index("--build-arg") + 1], f"AXIOM_RELEASE_SHA={SHA}")
            self.assertEqual(build[build.index("--label") + 1], f"org.opencontainers.image.revision={SHA}")
            self.assertEqual(build[build.index("-f") + 1], f"infra/docker/Dockerfile.{component}")
            self.assertEqual(build[build.index("-t") + 1], image)
            self.assertEqual(inspect, ["image", "inspect", image])
            self.assertEqual(push, ["push", image])

    def test_metadata_mismatch_never_pushes_affected_image(self):
        for component in ("web", "temporal-worker"):
            for mismatch in ("env", "label", "missing-env"):
                with self.subTest(component=component, mismatch=mismatch):
                    result, calls = self.run_publisher(mismatch, mismatch_component=component)
                    self.assertNotEqual(result.returncode, 0)
                    verified_prefix = COMPONENTS.index(component)
                    pushes = [call for call in calls if call[0] == "push"]
                    self.assertEqual(len(pushes), verified_prefix)
                    self.assertEqual(len(calls), verified_prefix * 3 + 2)
                    self.assertEqual(calls[-1], [
                        "image", "inspect", f"ghcr.io/axiomowner/axiom-{component}:{SHA}"
                    ])

    def test_invalid_source_sha_never_builds_or_pushes(self):
        result, calls = self.run_publisher(sha="not-a-commit")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, [])

    def test_python_images_embed_release_metadata_after_dependencies(self):
        for component in COMPONENTS[3:]:
            with self.subTest(component=component):
                source = (ROOT / f"infra/docker/Dockerfile.{component}").read_text()
                metadata = "ARG AXIOM_RELEASE_SHA\nENV AXIOM_RELEASE_SHA=$AXIOM_RELEASE_SHA\nLABEL org.opencontainers.image.revision=$AXIOM_RELEASE_SHA"
                self.assertIn(metadata, source)
                self.assertGreater(source.index(metadata), source.index("RUN uv sync --locked"))


if __name__ == "__main__":
    unittest.main()
