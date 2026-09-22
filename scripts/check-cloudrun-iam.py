#!/usr/bin/env python3
"""Fail on runtime identity/secret drift; complements evaluated Terraform mock tests."""
from __future__ import annotations

import json
import re
import runpy
import sys
from pathlib import Path

block_at = runpy.run_path(str(Path(__file__).with_name('check-cloudrun-auth-wiring.py')))['block_at']
# Reviewed runtime needs, not copied automatically from container declarations.
EXPECTED = {
    'bff': {'agent_runtime_internal_token', 'approval_signing_key',
            'gcs_hmac_access_key', 'gcs_hmac_secret_key', 'mfa_encryption_key',
            'model_gateway_api_key', 'resend_api_key', 'supabase_anon_key',
            'supabase_service_key'},
    'web': {'supabase_anon_key'},
    'marketing': {'supabase_anon_key', 'resend_api_key'},  # C-W0-6 mail migration remains open.
    'agent_runtime': {'agent_runtime_internal_token', 'approval_signing_key',
                      'gcs_hmac_access_key', 'gcs_hmac_secret_key',
                      'model_gateway_api_key', 'supabase_service_key'},
    'model_gateway': {'model_gateway_api_key', 'anthropic_api_key', 'openai_api_key',
                      'gemini_api_key', 'upstash_redis_url'},
    'temporal_worker': {'temporal_api_key', 'agent_runtime_internal_token'},
    'supabase_auth': {'gotrue_db_url', 'supabase_jwt_secret'},
    'supabase_rest': {'db_url', 'supabase_jwt_secret'},
    'supabase_gateway': set(),
}


def check(files: dict[str, str]) -> None:
    source = '\n'.join(files.values())
    assert 'google_service_account.cloudrun_sa' not in source, 'Shared runtime identity remains'
    # No runtime Google API operation currently needs a project-level role.
    assert not re.search(r'resource\s+"google_project_iam_(?:member|binding|policy)"', source), 'Unexpected project-wide runtime authority'
    secret_grants = re.findall(r'resource\s+"(google_secret_manager_secret_iam_[^"]+)"\s+"([^"]+)"', source)
    assert set(secret_grants) == {
        ('google_secret_manager_secret_iam_member', 'runtime_access'),
        ('google_secret_manager_secret_iam_member', 'mfa_previous_access'),
    } and len(secret_grants) == 2, 'Unexpected secret IAM grant outside the reviewed policy'
    assert not re.search(r'resource\s+"google_service_account_iam_[^"]+"', source), 'Unexpected service identity impersonation grant'
    services = {}
    for match in re.finditer(r'resource\s+"google_cloud_run_v2_service"\s+"([^"]+)"\s*{', source):
        name = match[1]
        assert name not in services, 'Duplicate service'
        services[name] = block_at(source, match.end() - 1)
    assert set(services) == set(EXPECTED), 'Review IAM when adding/removing a service'
    iam = files['iam.tf']
    for name, expected in EXPECTED.items():
        body = services[name]
        assert re.search(r'service_account\s*=\s*google_service_account.runtime\["' + name + r'"\].email', body), f'{name}: wrong identity'
        actual = set(re.findall(r'google_secret_manager_secret.secret\["([^"]+)"\]', body))
        assert actual == expected, f'{name}: unexpected/missing container secret binding'
        match = re.search(r'\b' + name + r'\s*=\s*{', iam)
        assert match, f'{name}: missing secret policy'
        policy = block_at(iam, match.end() - 1)
        secrets = re.search(r'\bsecrets\s*=\s*(\[[^\]]*\])', policy)
        assert secrets and set(json.loads(secrets[1])) == expected, f'{name}: unexpected/missing IAM permission'
        for dependency in ('google_secret_manager_secret_iam_member.runtime_access',
                           'google_secret_manager_secret_iam_member.mfa_previous_access',
                           'google_secret_manager_secret_version.version',
                           'google_secret_manager_secret_version.mfa_previous_keys'):
            deps = re.search(r'\bdepends_on\s*=\s*\[([^\]]*)\]', body)
            assert deps and dependency in deps[1], f'{name}: rollout can race secret permissions/versions'
    required = {
        'agent_runtime': {'SUPABASE_URL': 'local.supabase_preprod_url',
                          'SUPABASE_SERVICE_KEY': 'supabase_service_key',
                          'AGENT_RUNTIME_INTERNAL_TOKEN': 'agent_runtime_internal_token'},
        'temporal_worker': {'ENVIRONMENT': 'var.environment',
                            'AGENT_RUNTIME_INTERNAL_TOKEN': 'agent_runtime_internal_token'},
    }
    for service, bindings in required.items():
        environments = {}
        for match in re.finditer(r'\benv\s*{', services[service]):
            body = block_at(services[service], match.end() - 1)
            name = re.search(r'\bname\s*=\s*"([A-Z_]+)"', body)
            if name:
                assert name[1] not in environments, f'{service}: duplicate environment binding'
                environments[name[1]] = body
        for key, value in bindings.items():
            assert value in environments.get(key, ''), f'{service}: missing/wrong {key}'
    assert 'mfa_previous_keys' not in re.sub(r'depends_on\s*=\s*\[[^\]]*\]', '', services['web']) and 'mfa_previous_keys' not in re.sub(r'depends_on\s*=\s*\[[^\]]*\]', '', services['marketing']), 'Retiring keys must remain BFF-only'


if __name__ == '__main__':
    try:
        directory = Path(sys.argv[1] if len(sys.argv) > 1 else 'infra/terraform/envs/preprod')
        check({p.name: p.read_text() for p in directory.glob('*.tf')})
    except (AssertionError, ValueError) as error:
        sys.exit(str(error))
    print('Cloud Run IAM: nine service identities, exact secret allowlists and rollout dependencies verified.')
