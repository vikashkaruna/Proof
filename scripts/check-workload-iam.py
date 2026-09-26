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
    def refuse(message):
        raise SystemExit(message)

    source = '\n'.join(files.values())
    resources = {}
    for match in re.finditer(r'\bresource\s+"([^"]+)"\s+"([^"]+)"\s*{', source):
        key = (match[1], match[2])
        if key in resources:
            refuse('Duplicate workload resource')
        resources[key] = block_at(source, match.end()-1)
    if set(resources) != EXPECTED:
        refuse('Unexpected workload resource; review all authority changes')
    if re.search(r'\b(?:module|data|provisioner)\s+"', source):
        refuse('Indirect workload authority or external data source refused')
    member = 'member="serviceAccount:${google_service_account.host["runner-${each.value.tenant}"].email}"'
    for kind, role in [
        ('google_secret_manager_secret_iam_member', 'roles/secretmanager.secretAccessor'),
        ('google_kms_crypto_key_iam_member', 'roles/cloudkms.cryptoKeyDecrypter'),
    ]:
        body = re.sub(r'\s+', '', resources[(kind, 'controller')])
        if f'role="{role}"' not in body:
            refuse('Controller role exceeds reviewed operations')
        if member not in body:
            refuse('Controller permission is not bound to its tenant runner')
        if re.search(r'\bcondition\s*{', resources[(kind, 'controller')]):
            refuse('Review conditional IAM semantics explicitly')
    secret = re.sub(r'\s+', '', resources[('google_secret_manager_secret_iam_member', 'controller')])
    if 'secret_id=google_secret_manager_secret.controller[each.key].id' not in secret:
        refuse('Secret grant escaped its managed tenant resource')
    kms = re.sub(r'\s+', '', resources[('google_kms_crypto_key_iam_member', 'controller')])
    if 'crypto_key_id=each.value.key' not in kms:
        refuse('KMS grant escaped its explicit key inventory')
    if 'for_each=local.controller_keys' not in kms:
        refuse('KMS grant inventory changed')
    if 'for_each=local.controller_secrets' not in secret:
        refuse('Secret grant inventory changed')
    container = re.sub(r'\s+', '', resources[('google_secret_manager_secret', 'controller')])
    if 'prevent_destroy=true' not in container:
        refuse('Credential resource retirement needs explicit review')
    if 'replication{user_managed{replicas{location="asia-south1"}}}' not in container:
        refuse('Secret replication escaped Mumbai')


if __name__ == '__main__':
    try:
        root = Path(sys.argv[1] if len(sys.argv)>1 else 'infra/terraform/modules/workload-vms')
        check({p.name:p.read_text() for p in root.glob('*.tf')})
    except ValueError as error:
        sys.exit(str(error))
    print('Workload IAM source inventory: tenant secret access and key decryption only; effective cloud access remains unverified.')
