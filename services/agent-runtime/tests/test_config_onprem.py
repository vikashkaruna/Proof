"""On-prem runtime retains the hardened production posture."""
import base64
import json
import time

import pytest

from axiom.config import Settings


def _writer_jwt(role: str = 'agent_ledger_writer') -> str:
    def part(value: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b'=').decode()

    return f"{part({'alg': 'HS256'})}.{part({'role': role, 'exp': int(time.time()) + 600})}.sig"


# 0099: production-like modes require a distinct agent-ledger-writer JWT plus the
# public apikey Kong needs; these tests exercise the other onprem inputs.
LEDGER_WRITER = {
    'supabase_anon_key': 'synthetic-anon-key-for-tests',
    'supabase_agent_ledger_writer_key': _writer_jwt(),
}


def test_onprem_rejects_demo_service_role_key():
    with pytest.raises(ValueError, match='SUPABASE_SERVICE_KEY'):
        Settings(
            environment='onprem',
            supabase_url='http://supabase-gateway:80',
            supabase_service_key=Settings.model_fields['supabase_service_key'].default,
            internal_token='runtime-private',
            approval_signing_key='approval-private',
            model_gateway_api_key='gateway-private',
        )


def test_onprem_requires_distinct_internal_security_inputs():
    with pytest.raises(ValueError, match='AGENT_RUNTIME_INTERNAL_TOKEN'):
        Settings(
            environment='onprem',
            supabase_url='http://supabase-gateway:80',
            supabase_service_key='signed-local-service-role-token',
            **LEDGER_WRITER,
        )


def test_onprem_accepts_local_protected_dependencies():
    settings = Settings(
        environment='onprem',
        supabase_url='http://supabase-gateway:80',
        supabase_service_key='signed-local-service-role-token',
        internal_token='runtime-private',
        approval_signing_key='approval-private',
        model_gateway_api_key='gateway-private',
        temporal_address='temporal:7233',
        temporal_tls=False,
        **LEDGER_WRITER,
    )
    assert settings.environment == 'onprem'
    assert settings.temporal_address == 'temporal:7233'
