"""On-prem runtime retains the hardened production posture."""
import pytest

from axiom.config import Settings


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
    )
    assert settings.environment == 'onprem'
    assert settings.temporal_address == 'temporal:7233'
