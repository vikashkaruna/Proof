"""Prove the commit guard, the Claude hook and the name checker enforce the doc boundary."""
import json
from pathlib import Path
import shutil
# Only trusted resolved programs run, against disposable fixture repositories.
import subprocess  # nosec B404
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
GIT, BASH = shutil.which('git'), shutil.which('bash')
FAKE_TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'  # fictional, split to avoid scanner hits


@unittest.skipUnless(GIT and BASH, 'Git and Bash are required')
class CommitGuardTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.git('init', '-q')

    def git(self, *args):
        return subprocess.run([GIT, *args], cwd=self.root, check=True, capture_output=True, text=True)  # nosec B603

    def stage(self, relative, text='Fictional fixture\n'):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        self.git('add', '-f', relative)

    def guard(self):
        return subprocess.run([BASH, str(ROOT / 'scripts/guard-private-docs.sh'), '--staged'],
                              cwd=self.root, capture_output=True, text=True)  # nosec B603

    def test_shared_doc_with_marker_and_readmes_pass(self):
        self.stage('docs/shared-docs/overview.md', '---\nclassification: shared\n---\n# Overview\n')
        self.stage('docs/README.md')
        self.assertEqual(self.guard().returncode, 0, self.guard().stderr)

    def test_private_zone_files_are_blocked(self):
        for relative in ('docs/private-docs/operator/OPS-00-platform-ops.md',
                         'docs/private-plans/PLAN-02-x.md', 'docs/legacy-flat.md', 'private-docs/x.md'):
            with self.subTest(relative=relative):
                self.setUp()
                self.stage(relative)
                result = self.guard()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('is private', result.stderr)

    def test_shared_doc_without_marker_is_blocked(self):
        self.stage('docs/shared-docs/overview.md', '# No marker\n')
        self.assertIn('classification: shared', self.guard().stderr)

    def test_secret_file_names_and_values_are_blocked_and_redacted(self):
        self.stage('.env.local', 'A=1\n')
        self.stage('notes.md', 'api_key: ' + 'q' * 24 + '\n')
        result = self.guard()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('secret or confidential', result.stderr)
        self.assertNotIn('q' * 24, result.stderr)

    def test_env_examples_are_allowed(self):
        self.stage('.env.example', 'A=\n')
        self.assertEqual(self.guard().returncode, 0, self.guard().stderr)

    def test_standalone_tokens_are_rejected_without_disclosing_values(self):
        tokens = ('AKIA' + 'X' * 16, 'ghp_' + 'x' * 36,
                  'eyJ' + 'a' * 24 + '.' + 'b' * 24 + '.' + 'c' * 24)
        for relative in ('notes.md', 'src/example.ts'):
            for token in tokens:
                with self.subTest(relative=relative, token_type=token[:4]):
                    self.setUp()
                    self.stage(relative, 'rejected credential: ' + token + '\n')
                    result = self.guard()
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn(token, result.stdout + result.stderr)


class ClaudeHookTests(unittest.TestCase):
    def run_hook(self, tool, **tool_input):
        return subprocess.run([sys.executable, str(ROOT / '.claude/hooks/block_private_leak.py')],
                              input=json.dumps({'tool_name': tool, 'tool_input': tool_input}),
                              capture_output=True, text=True)  # nosec B603

    def test_blocks_force_add_no_verify_and_private_staging(self):
        for command in ('git add -f docs/x.md', 'git add docs/private-docs/operator/OPS-00-platform-ops.md',
                        'git -c core.x=1 commit --no-verify -m x', 'git push --no-verify'):
            with self.subTest(command=command):
                self.assertEqual(self.run_hook('Bash', command=command).returncode, 2)

    def test_allows_normal_git_and_shared_docs(self):
        for command in ('git add docs/shared-docs/overview.md', 'git add docs/private-docs/README.md',
                        'git commit -m x'):
            with self.subTest(command=command):
                self.assertEqual(self.run_hook('Bash', command=command).returncode, 0)

    def test_blocks_secret_in_docs_and_unmarked_shared_doc(self):
        self.assertEqual(self.run_hook('Write', file_path='/r/docs/shared-docs/a.md',
                                       content='---\nclassification: shared\n---\n' + FAKE_TOKEN).returncode, 2)
        self.assertEqual(self.run_hook('Write', file_path='/r/docs/shared-docs/a.md', content='# x').returncode, 2)

    def test_enforces_private_naming_but_exempts_archive(self):
        self.assertEqual(self.run_hook('Write', file_path='/r/docs/private-docs/operator/handoff v2.md',
                                       content='x').returncode, 2)
        self.assertEqual(self.run_hook('Write', file_path='/r/docs/private-docs/operator/OPS-03-connectors.md',
                                       content='x').returncode, 0)
        self.assertEqual(self.run_hook('Write', file_path='/r/docs/private-docs/archive/Old Name.md',
                                       content='x').returncode, 0)


class NameCheckerTests(unittest.TestCase):
    def test_reports_bad_names_and_unsorted_session_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / 'scripts').mkdir()
            shutil.copy(ROOT / 'scripts/check-doc-names.py', repo / 'scripts/check-doc-names.py')
            ops = repo / 'docs/private-docs/operator'
            ops.mkdir(parents=True)
            (ops / 'OPS-03-connectors.md').write_text('ok')
            (ops / 'Runbook v2.md').write_text('bad')
            log = repo / 'docs/private-docs/status/STATUS-session-log.md'
            log.parent.mkdir(parents=True)
            log.write_text('<!-- NEWEST SESSION ENTRIES GO BELOW THIS LINE -->\n### 2026-01-01 a\n### 2026-02-01 b\n')
            result = subprocess.run([sys.executable, str(repo / 'scripts/check-doc-names.py')],
                                    capture_output=True, text=True)  # nosec B603
            self.assertEqual(result.returncode, 1)
            self.assertIn('Runbook v2.md', result.stderr)
            self.assertIn('reverse chronological', result.stderr)
            (ops / 'Runbook v2.md').unlink()
            log.write_text('<!-- NEWEST SESSION ENTRIES GO BELOW THIS LINE -->\n### 2026-02-01 b\n### 2026-01-01 a\n')
            ok = subprocess.run([sys.executable, str(repo / 'scripts/check-doc-names.py')],
                                capture_output=True, text=True)  # nosec B603
            self.assertEqual(ok.returncode, 0, ok.stderr)


if __name__ == '__main__':
    unittest.main()
