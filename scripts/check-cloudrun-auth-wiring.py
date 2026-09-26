#!/usr/bin/env python3
"""Check the actual Cloud Run env bindings, not only Terraform variable existence."""
import re
import sys
from pathlib import Path


def block_at(source, opening):
    # Balanced blocks; skip quoted strings and comments so braces inside them
    # cannot make one resource satisfy another resource's credential contract.
    depth = 0
    tokens = re.finditer(r'"(?:\\.|[^"\\])*"|#[^\n]*|//[^\n]*|/\*[\s\S]*?\*/|[{}]', source[opening:])
    for token in tokens:
        if token.group() == '{':
            depth += 1
        elif token.group() == '}':
            depth -= 1
            if depth == 0:
                return source[opening:opening + token.end()]
    raise ValueError('Unterminated Terraform block')


def check(source):
    def refuse(message):
        raise SystemExit(message)

    for service in ('bff', 'web', 'marketing'):
        match = re.search(r'resource\s+"google_cloud_run_v2_service"\s+"' + service + r'"\s*{', source)
        if match is None:
            refuse(f'Missing Cloud Run service {service}')
        resource = block_at(source, match.end() - 1)
        env = {}
        for match in re.finditer(r'\benv\s*{', resource):
            block = block_at(resource, match.end() - 1)
            name = re.search(r'\bname\s*=\s*"([A-Z_]+)"', block)
            if name:
                if name[1] in env:
                    refuse(f'{service}: duplicate {name[1]}')
                env[name[1]] = block
        required = {'SUPABASE_ANON_KEY': 'supabase_anon_key'}
        if service == 'bff':
            required['SUPABASE_SERVICE_KEY'] = 'supabase_service_key'
        else:
            required['NEXT_PUBLIC_SUPABASE_ANON_KEY'] = 'supabase_anon_key'
            for private in ('SUPABASE_SERVICE_KEY', 'APPROVAL_SIGNING_KEY', 'AXIOM_MFA_ENCRYPTION_KEY', 'AGENT_RUNTIME_INTERNAL_TOKEN'):
                if private in env:
                    refuse(f'{service}: backend credential {private} must not be injected into SSR')
        for name, secret in required.items():
            block = env.get(name, '')
            if 'value_source' not in block or 'secret_key_ref' not in block:
                refuse(f'{service}: {name} must use a managed secret reference')
            if f'google_secret_manager_secret.secret["{secret}"].secret_id' not in block:
                refuse(f'{service}: wrong source for {name}')
            if 'placeholder' in block:
                refuse(f'{service}: placeholder credential')


if __name__ == '__main__':
    try:
        check(Path(sys.argv[1] if len(sys.argv) > 1 else 'infra/terraform/envs/preprod/cloudrun.tf').read_text())
    except ValueError as error:
        sys.exit(str(error))
    print('Cloud Run Auth wiring: managed BFF credentials; scoped SSR credentials only.')
