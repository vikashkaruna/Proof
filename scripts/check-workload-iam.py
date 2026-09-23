#!/usr/bin/env python3
"""Review gate for the complete workload-module resource inventory and grants.

Complements evaluated mock-provider Terraform tests. Never claims to inspect
inherited cloud IAM, secret payloads, actual VM identities or KMS readiness.
"""
from __future__ import annotations
import re
import runpy
import sys
from pathlib import Path

block_at = runpy.run_path(str(Path(__file__).with_name('check-cloudrun-auth-wiring.py')))['block_at']
EXPECTED = {
    ('google_service_account', 'host'), ('google_compute_address', 'host'),
    ('google_compute_disk', 'state'), ('google_compute_instance', 'host'),
    *{('google_compute_firewall', name) for name in
      ['deny_ingress', 'spire', 'controller', 'deny_egress', 'https_egress', 'spire_egress']},
    ('google_secret_manager_secret', 'controller'),
    ('google_secret_manager_secret_iam_member', 'controller'),
    ('google_kms_crypto_key_iam_member', 'controller'),
}


def check(files: dict[str, str]) -> None:
    source = '\n'.join(files.values())
    resources = {}
    for match in re.finditer(r'\bresource\s+"([^"]+)"\s+"([^"]+)"\s*{', source):
        key = (match[1], match[2])
        assert key not in resources, 'Duplicate workload resource'
        resources[key] = block_at(source, match.end()-1)
    assert set(resources) == EXPECTED, 'Unexpected workload resource; review all authority changes'
    assert not re.search(r'\b(?:module|data|provisioner)\s+"', source), 'Indirect workload authority or external data source refused'
    member = 'member="serviceAccount:${google_service_account.host["runner-${each.value.tenant}"].email}"'
    for kind, role in [
        ('google_secret_manager_secret_iam_member', 'roles/secretmanager.secretAccessor'),
        ('google_kms_crypto_key_iam_member', 'roles/cloudkms.cryptoKeyDecrypter'),
    ]:
        body = re.sub(r'\s+', '', resources[(kind, 'controller')])
        assert f'role="{role}"' in body, 'Controller role exceeds reviewed operations'
        assert member in body, 'Controller permission is not bound to its tenant runner'
        assert not re.search(r'\bcondition\s*{', resources[(kind, 'controller')]), 'Review conditional IAM semantics explicitly'
    secret = re.sub(r'\s+', '', resources[('google_secret_manager_secret_iam_member', 'controller')])
    assert 'secret_id=google_secret_manager_secret.controller[each.key].id' in secret, 'Secret grant escaped its managed tenant resource'
    kms = re.sub(r'\s+', '', resources[('google_kms_crypto_key_iam_member', 'controller')])
    assert 'crypto_key_id=each.value.key' in kms, 'KMS grant escaped its explicit key inventory'
    assert 'for_each=local.controller_keys' in kms, 'KMS grant inventory changed'
    assert 'for_each=local.controller_secrets' in secret, 'Secret grant inventory changed'
    container = re.sub(r'\s+', '', resources[('google_secret_manager_secret', 'controller')])
    assert 'prevent_destroy=true' in container, 'Credential resource retirement needs explicit review'
    assert 'replication{user_managed{replicas{location="asia-south1"}}}' in container, 'Secret replication escaped Mumbai'


if __name__ == '__main__':
    try:
        root = Path(sys.argv[1] if len(sys.argv)>1 else 'infra/terraform/modules/workload-vms')
        check({p.name:p.read_text() for p in root.glob('*.tf')})
    except (AssertionError, ValueError) as error:
        sys.exit(str(error))
    print('Workload IAM source inventory: tenant secret access and key decryption only; effective cloud access remains unverified.')
