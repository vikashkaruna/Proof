"""Prove ignored documentation cannot silently return to the Git index."""
from pathlib import Path
import shutil
# Only trusted resolved Git/Bash programs run against disposable test repositories.
import subprocess  # nosec B404
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
GIT = shutil.which('git')
BASH = shutil.which('bash')


@unittest.skipUnless(GIT and BASH, 'Git and Bash are required')
class PrivateDocsGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git('init', '-q')
        (self.root / '.gitignore').write_text((ROOT / '.gitignore').read_text())
        (self.root / 'README.md').write_text('# Public navigation pointer\n')
        self.git('add', '.gitignore', 'README.md')

    def git(self, *args):
        # Trusted test arguments operate only on the disposable fixture repository.
        return subprocess.run([GIT, *args], cwd=self.root, check=True,
                              capture_output=True, text=True)  # nosec B603

    def guard(self):
        # Execute the reviewed local guard against the disposable fixture only.
        return subprocess.run([BASH, str(ROOT / 'scripts/check-private-docs.sh')],
                              cwd=self.root, capture_output=True, text=True)  # nosec B603

    def force_track(self, relative):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('Fictional confidential fixture; never real operator data.\n')
        self.git('add', '-f', relative)

    def test_public_navigation_and_ignored_pack_pass(self):
        path = self.root / 'private-docs/help/internal/founder.md'
        path.parent.mkdir(parents=True)
        path.write_text('Fictional private manual fixture\n')
        result = self.guard()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('no documentation content was read', result.stdout)

    def test_force_tracking_private_manual_fails(self):
        self.force_track('private-docs/help/internal/founder.md')
        result = self.guard()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('must not be tracked', result.stderr)
        self.assertNotIn('Fictional confidential fixture', result.stderr)

    def test_force_tracking_legacy_architecture_fails(self):
        self.force_track('docs/04_Solution_Architecture.md')
        self.assertNotEqual(self.guard().returncode, 0)

    def test_force_tracking_component_guide_fails(self):
        self.force_track('services/agent-runtime/README.md')
        self.assertNotEqual(self.guard().returncode, 0)

    def test_missing_ignore_rule_fails_even_without_tracked_docs(self):
        (self.root / '.gitignore').write_text('node_modules/\n')
        result = self.guard()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ignore rules', result.stderr)


if __name__ == '__main__':
    unittest.main()
