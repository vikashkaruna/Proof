"""Permission widening and secret-material drift must fail the source review gate."""
import runpy
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
CHECK = runpy.run_path(str(ROOT/'scripts/check-workload-iam.py'))['check']

class WorkloadIamTests(unittest.TestCase):
    def setUp(self):
        self.files={p.name:p.read_text() for p in (ROOT/'infra/terraform/modules/workload-vms').glob('*.tf')}

    def test_current_policy(self):
        CHECK(self.files)

    def test_no_unreviewed_resources(self):
        for kind in ['google_project_iam_member','google_folder_iam_binding',
                     'google_organization_iam_member','google_kms_key_ring_iam_member',
                     'google_service_account_iam_member','google_service_account_key',
                     'google_secret_manager_secret_version','local_file','null_resource']:
            with self.subTest(kind=kind):
                files=dict(self.files);files['rogue.tf']=f'resource "{kind}" "rogue" {{}}'
                with self.assertRaisesRegex(SystemExit,'Unexpected workload resource'):CHECK(files)

    def test_no_indirect_authority_or_payload_reads(self):
        for block in ['module "backdoor" {}','data "google_secret_manager_secret_version" "backdoor" {}','provisioner "local-exec" {}']:
            with self.subTest(block=block):
                files=dict(self.files);files['rogue.tf']=block
                with self.assertRaisesRegex(SystemExit,'Indirect workload authority'):CHECK(files)

    def test_no_encrypt_or_admin_role(self):
        for role in ['roles/cloudkms.cryptoKeyEncrypterDecrypter','roles/cloudkms.admin','roles/owner']:
            with self.subTest(role=role):
                files=dict(self.files);files['permissions.tf']=files['permissions.tf'].replace('roles/cloudkms.cryptoKeyDecrypter',role)
                with self.assertRaisesRegex(SystemExit,'reviewed operations'):CHECK(files)

    def test_no_secret_admin_role(self):
        self.files['permissions.tf']=self.files['permissions.tf'].replace('roles/secretmanager.secretAccessor','roles/secretmanager.admin')
        with self.assertRaisesRegex(SystemExit,'reviewed operations'):CHECK(self.files)

    def test_no_issuer_or_other_tenant_grant(self):
        for key in ['issuer','runner-22222222-2222-4222-8222-222222222222']:
            with self.subTest(key=key):
                files=dict(self.files);files['permissions.tf']=files['permissions.tf'].replace('host["runner-${each.value.tenant}"]',f'host["{key}"]')
                with self.assertRaisesRegex(SystemExit,'tenant runner'):CHECK(files)

    def test_no_shared_backend_secret(self):
        self.files['permissions.tf']=self.files['permissions.tf'].replace('google_secret_manager_secret.controller[each.key].id','"projects/fixture/secrets/supabase_service_key"')
        with self.assertRaisesRegex(SystemExit,'managed tenant resource'):CHECK(self.files)

    def test_no_key_outside_inventory(self):
        self.files['permissions.tf']=self.files['permissions.tf'].replace('crypto_key_id = each.value.key','crypto_key_id = "projects/fixture/locations/asia-south1/keyRings/shared/cryptoKeys/shared"')
        with self.assertRaisesRegex(SystemExit,'explicit key inventory'):CHECK(self.files)

    def test_no_foreign_secret_replica(self):
        self.files['permissions.tf']=self.files['permissions.tf'].replace('location = "asia-south1"','location = "us-central1"')
        with self.assertRaisesRegex(SystemExit,'Mumbai'):CHECK(self.files)

    def test_no_implicit_secret_retirement(self):
        self.files['permissions.tf']=self.files['permissions.tf'].replace('prevent_destroy = true','prevent_destroy = false')
        with self.assertRaisesRegex(SystemExit,'retirement'):CHECK(self.files)

if __name__=='__main__':unittest.main()
