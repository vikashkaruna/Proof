"""Mutation checks: permission drift must fail even when Terraform is valid."""
import runpy
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CHECK = runpy.run_path(str(ROOT / 'scripts/check-cloudrun-iam.py'))['check']


class RuntimeIamTests(unittest.TestCase):
    def setUp(self):
        self.files = {p.name: p.read_text() for p in (ROOT / 'infra/terraform/envs/preprod').glob('*.tf')}

    def test_deploy_and_teardown_cover_new_identity_and_rotation_resources(self):
        for script in ['deploy-preprod-gcp.sh', 'teardown-preprod-gcp.sh']:
            source = (ROOT / 'scripts' / script).read_text()
            self.assertNotIn('google_service_account.cloudrun_sa', source)
            for address in [
                'google_service_account.runtime',
                'google_secret_manager_secret_iam_member.runtime_access',
                'google_secret_manager_secret_iam_member.mfa_previous_access',
                'google_secret_manager_secret.mfa_previous_keys',
                'google_secret_manager_secret_version.mfa_previous_keys',
            ]:
                self.assertEqual(source.count('-target=' + address), 2, (script, address))
        source = (ROOT / 'scripts/teardown-preprod-gcp.sh').read_text()
        for service in ['supabase_auth', 'supabase_rest', 'supabase_gateway']:
            self.assertEqual(source.count('-target=google_cloud_run_v2_service.' + service), 2)

    def test_current_policy(self):
        CHECK(self.files)

    def test_other_service_identity_is_refused(self):
        self.files['cloudrun.tf'] = self.files['cloudrun.tf'].replace('runtime["web"].email', 'runtime["bff"].email')
        with self.assertRaisesRegex(AssertionError, 'wrong identity'):
            CHECK(self.files)

    def test_project_wide_secret_permission_is_refused(self):
        self.files['iam.tf'] += '\nresource "google_project_iam_member" "backdoor" {role="roles/secretmanager.secretAccessor"}\n'
        with self.assertRaisesRegex(AssertionError, 'project-wide'):
            CHECK(self.files)

    def test_grant_outside_the_policy_is_refused(self):
        self.files['iam.tf'] += '\nresource "google_secret_manager_secret_iam_member" "rogue" {}\n'
        with self.assertRaisesRegex(AssertionError, 'outside the reviewed policy'):
            CHECK(self.files)

    def test_impersonation_grant_is_refused(self):
        self.files['iam.tf'] += '\nresource "google_service_account_iam_member" "rogue" {}\n'
        with self.assertRaisesRegex(AssertionError, 'impersonation'):
            CHECK(self.files)

    def test_extra_iam_secret_is_refused(self):
        self.files['iam.tf'] = self.files['iam.tf'].replace('["supabase_anon_key"]', '["supabase_anon_key", "supabase_service_key"]')
        with self.assertRaisesRegex(AssertionError, 'IAM permission'):
            CHECK(self.files)

    def test_secret_mount_without_permission_is_refused(self):
        self.files['cloudrun.tf'] = self.files['cloudrun.tf'].replace('secret["supabase_anon_key"]', 'secret["supabase_service_key"]')
        with self.assertRaisesRegex(AssertionError, 'container secret'):
            CHECK(self.files)

    def test_missing_rotation_dependency_is_refused(self):
        self.files['cloudrun.tf'] = self.files['cloudrun.tf'].replace('    google_secret_manager_secret_iam_member.mfa_previous_access,\n', '')
        with self.assertRaisesRegex(AssertionError, 'rollout can race'):
            CHECK(self.files)

    def test_wrong_temporal_token_binding_is_refused(self):
        self.files['cloudrun.tf'] = self.files['cloudrun.tf'].replace('name = "AGENT_RUNTIME_INTERNAL_TOKEN"', 'name = "UNREAD_TOKEN"')
        with self.assertRaisesRegex(AssertionError, 'missing/wrong'):
            CHECK(self.files)


if __name__ == '__main__':
    unittest.main()
