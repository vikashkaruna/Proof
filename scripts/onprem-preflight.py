#!/usr/bin/env python3
"""Fail-closed validation of the operator-owned sovereign environment file."""
from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

REQUIRED = (
    'AXIOM_BIND_ADDRESS', 'NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_BFF_URL',
    'NEXT_PUBLIC_SUPABASE_URL', 'BFF_CORS_ORIGINS', 'SUPABASE_JWT_SECRET',
    'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_KEY', 'POSTGRES_PASSWORD',
    'TEMPORAL_DB_PASSWORD', 'POSTGREST_DB_PASSWORD', 'APPROVAL_SIGNING_KEY', 'AXIOM_MFA_ENCRYPTION_KEY',
    'AGENT_RUNTIME_INTERNAL_TOKEN', 'MODEL_GATEWAY_API_KEY',
    'AXIOM_STORAGE_ACCESS_KEY_ID', 'AXIOM_STORAGE_SECRET_ACCESS_KEY',
    'AXIOM_EVIDENCE_BUCKET', 'AXIOM_OFFLINE_LICENSE',
    'AXIOM_WORM_SERVER_IMAGE', 'AXIOM_WORM_CLIENT_IMAGE',
    'AXIOM_POSTGRES_IMAGE', 'AXIOM_AUTH_IMAGE', 'AXIOM_POSTGREST_IMAGE',
    'AXIOM_INGRESS_IMAGE', 'AXIOM_TEMPORAL_POSTGRES_IMAGE', 'AXIOM_TEMPORAL_IMAGE',
    'AXIOM_REDIS_IMAGE', 'AXIOM_MODEL_GATEWAY_IMAGE', 'AXIOM_AGENT_RUNTIME_IMAGE',
    'AXIOM_BFF_IMAGE', 'AXIOM_WORKER_IMAGE', 'AXIOM_WEB_IMAGE',
)
SECRETS = (
    'SUPABASE_JWT_SECRET', 'POSTGRES_PASSWORD', 'POSTGREST_DB_PASSWORD', 'TEMPORAL_DB_PASSWORD',
    'APPROVAL_SIGNING_KEY', 'AXIOM_MFA_ENCRYPTION_KEY',
    'AGENT_RUNTIME_INTERNAL_TOKEN', 'MODEL_GATEWAY_API_KEY',
    'AXIOM_STORAGE_ACCESS_KEY_ID', 'AXIOM_STORAGE_SECRET_ACCESS_KEY',
)


def read_env(path: Path) -> dict[str, str]:
    if not path.is_file() or path.is_symlink():
        raise ValueError('Environment must be a regular non-symlink file')
    if path.stat().st_mode & 0o077:
        raise ValueError('Environment file must have mode 0600 or stricter')
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        if '=' not in line:
            raise ValueError('Malformed environment line')
        name, value = line.split('=', 1)
        if not re.fullmatch(r'[A-Z][A-Z0-9_]*', name) or name in values:
            raise ValueError('Duplicate or invalid environment key')
        values[name] = value
    for name in REQUIRED:
        if not values.get(name) or '<' in values[name] or '>' in values[name]:
            raise ValueError(f'{name} is required and cannot be a placeholder')
    if len({values[name] for name in SECRETS}) != len(SECRETS):
        raise ValueError('Operator secrets must be distinct')
    for name in SECRETS:
        if len(values[name]) < 32 or values[name] in {'minioadmin', 'postgres', 'mock'}:
            raise ValueError(f'{name} is too weak')
    if not re.fullmatch(r'[0-9a-f]{64}', values['APPROVAL_SIGNING_KEY']):
        raise ValueError('APPROVAL_SIGNING_KEY must be 64 hex chars')
    if not re.fullmatch(r'[0-9a-f]{64}', values['AXIOM_MFA_ENCRYPTION_KEY']):
        raise ValueError('AXIOM_MFA_ENCRYPTION_KEY must be 64 hex chars')
    for name in ('POSTGRES_PASSWORD', 'POSTGREST_DB_PASSWORD', 'TEMPORAL_DB_PASSWORD'):
        if not re.fullmatch(r'[0-9a-f]{64}', values[name]):
            raise ValueError(f'{name} must be 64 hex chars')
    for name in (name for name in REQUIRED if name.endswith('_IMAGE')):
        if not re.fullmatch(r'[a-zA-Z0-9._/-]+@sha256:[0-9a-f]{64}', values[name]):
            raise ValueError(f'{name} must be an approved immutable image digest')
    bind = ipaddress.ip_address(values['AXIOM_BIND_ADDRESS'])
    if not bind.is_private or bind.is_unspecified:
        raise ValueError('AXIOM_BIND_ADDRESS must be a private intranet IP')
    for name in ('NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_BFF_URL', 'NEXT_PUBLIC_SUPABASE_URL'):
        parsed = urlparse(values[name])
        if parsed.scheme not in {'http', 'https'} or not parsed.hostname:
            raise ValueError(f'{name} must be an absolute intranet URL')
        try:
            address = ipaddress.ip_address(parsed.hostname)
        except ValueError:
            if '.' in parsed.hostname and not parsed.hostname.endswith(('.local', '.internal')):
                raise ValueError(f'{name} must use an intranet hostname')
        else:
            if not address.is_private:
                raise ValueError(f'{name} must use an intranet IP')
    model_url = values.get('SELF_HOSTED_BASE_URL', '')
    if model_url:
        parsed = urlparse(model_url)
        if parsed.scheme != 'http' or parsed.hostname != 'local-model':
            raise ValueError('SELF_HOSTED_BASE_URL must name local-model on the sovereign network')
    for name in ('ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'):
        if values.get(name):
            raise ValueError(f'{name} is prohibited onprem')
    for role, name in (('anon', 'SUPABASE_ANON_KEY'), ('service_role', 'SUPABASE_SERVICE_KEY')):
        token = values[name]
        parts = token.split('.')
        if len(parts) != 3:
            raise ValueError(f'{name} is not a JWT')
        signature = base64.urlsafe_b64encode(
            hmac.new(values['SUPABASE_JWT_SECRET'].encode(),
                     f'{parts[0]}.{parts[1]}'.encode(), hashlib.sha256).digest()
        ).decode().rstrip('=')
        if not hmac.compare_digest(signature, parts[2]):
            raise ValueError(f'{name} is not signed by SUPABASE_JWT_SECRET')
        import json
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + '=' * (-len(parts[1]) % 4)))
        if payload.get('role') != role:
            raise ValueError(f'{name} has the wrong role')
    return values


if __name__ == '__main__':
    try:
        read_env(Path(sys.argv[1]))
    except (ValueError, IndexError, OSError) as exc:
        print(f'onprem preflight failed: {exc}', file=sys.stderr)
        sys.exit(1)
    print('On-prem environment validated')
