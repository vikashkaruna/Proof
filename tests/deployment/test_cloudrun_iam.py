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

    def test_source_signing_permission_is_exactly_bff_runtime_only(self):
        CHECK(self.files)
        iam = self.files['iam.tf']
        self.assertEqual(iam.count('"planning_source_signing_key"'), 2)
        cloudrun = self.files['cloudrun.tf']
        self.assertEqual(cloudrun.count('name = "AXIOM_PLANNING_SOURCE_SIGNING_KEY"'), 2)
        secrets = self.files['secrets.tf']
        self.assertIn('random_password.internal_service_key["planning_source_signing_key"].result', secrets)
        self.assertNotIn('planning_source_signing_key = var.agent_runtime_internal_token', secrets)

    def test_planning_source_key_in_worker_or_ssr_is_refused(self):
        for role in ('temporal_worker', 'web', 'model_gateway'):
            files = dict(self.files)
            marker = 'resource "google_cloud_run_v2_service" "' + role + '" {'
            files['cloudrun.tf'] = files['cloudrun.tf'].replace(marker, marker + '\n env { name="AXIOM_PLANNING_SOURCE_SIGNING_KEY" value_source { secret_key_ref { secret=google_secret_manager_secret.secret["planning_source_signing_key"].secret_id } } }')
            with self.subTest(role=role), self.assertRaisesRegex(SystemExit, 'container secret'):
                CHECK(files)

    def test_helm_source_key_is_optional_and_only_in_bff_runtime(self):
        templates = ROOT / 'infra/helm/axiom-proof/templates'
        holders = {p.name for p in templates.glob('*.yaml') if 'name: AXIOM_PLANNING_SOURCE_SIGNING_KEY' in p.read_text()}
        self.assertEqual(holders, {'bff-deployment.yaml', 'agent-runtime-deployment.yaml'})
        for name in holders:
            text = (templates / name).read_text().split('name: AXIOM_PLANNING_SOURCE_SIGNING_KEY', 1)[1].split('- name:', 1)[0]
            self.assertIn('-planning-source', text)
            self.assertIn('key: signing-key', text)
            self.assertIn('optional: true', text)

    def test_source_key_missing_from_runtime_iam_is_refused(self):
        self.files['iam.tf'] = self.files['iam.tf'].replace('"planning_source_signing_key", ', '', 1)
        with self.assertRaisesRegex(SystemExit, 'IAM permission'):
            CHECK(self.files)

    def test_other_service_identity_is_refused(self):
        self.files['cloudrun.tf'] = self.files['cloudrun.tf'].replace('runtime["web"].email', 'runtime["bff"].email')
        with self.assertRaisesRegex(SystemExit, 'wrong identity'):
            CHECK(self.files)

    def test_project_wide_secret_permission_is_refused(self):
        self.files['iam.tf'] += '\nresource "google_project_iam_member" "backdoor" {role="roles/secretmanager.secretAccessor"}\n'
        with self.assertRaisesRegex(SystemExit, 'project-wide'):
            CHECK(self.files)

    def test_grant_outside_the_policy_is_refused(self):
        self.files['iam.tf'] += '\nresource "google_secret_manager_secret_iam_member" "rogue" {}\n'
        with self.assertRaisesRegex(SystemExit, 'outside the reviewed policy'):
            CHECK(self.files)

    def test_impersonation_grant_is_refused(self):
        self.files['iam.tf'] += '\nresource "google_service_account_iam_member" "rogue" {}\n'
        with self.assertRaisesRegex(SystemExit, 'impersonation'):
            CHECK(self.files)

    def test_extra_iam_secret_is_refused(self):
        self.files['iam.tf'] = self.files['iam.tf'].replace('["supabase_anon_key"]', '["supabase_anon_key", "supabase_service_key"]')
        with self.assertRaisesRegex(SystemExit, 'IAM permission'):
            CHECK(self.files)

    def test_secret_mount_without_permission_is_refused(self):
        self.files['cloudrun.tf'] = self.files['cloudrun.tf'].replace('secret["supabase_anon_key"]', 'secret["supabase_service_key"]')
        with self.assertRaisesRegex(SystemExit, 'container secret'):
            CHECK(self.files)

    def test_missing_rotation_dependency_is_refused(self):
        self.files['cloudrun.tf'] = self.files['cloudrun.tf'].replace('    google_secret_manager_secret_iam_member.mfa_previous_access,\n', '')
        with self.assertRaisesRegex(SystemExit, 'rollout can race'):
            CHECK(self.files)

    def test_wrong_temporal_token_binding_is_refused(self):
        self.files['cloudrun.tf'] = self.files['cloudrun.tf'].replace('name = "AGENT_RUNTIME_INTERNAL_TOKEN"', 'name = "UNREAD_TOKEN"')
        with self.assertRaisesRegex(SystemExit, 'missing/wrong'):
            CHECK(self.files)


if __name__ == '__main__':
    unittest.main()
