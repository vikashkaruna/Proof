"""Unmounted Temporal consumers of shared pure accounting contracts.

Expected witnesses originate in independent scoped controller reads. No RPC,
credential, gateway or durable claim is created; legacy activities stay separate.
"""

from __future__ import annotations

from axiom_model_accounting import (
    ExpectedResult,
    LegacyAccountingView,
    ResultRefused,
    VerifiedAccountedResult,
    verify_accounted_result,
)

from .contracts import ProtocolRefused


def parse_accounted_runtime_result(
    value: object, expected: ExpectedResult
) -> VerifiedAccountedResult:
    try:
        return verify_accounted_result(value, expected)
    except ResultRefused:
        raise ProtocolRefused() from None


def validated_accounted_output(
    value: object, expected: ExpectedResult
) -> dict[str, object]:
    result = parse_accounted_runtime_result(value, expected)
    if result.result.status == "failed":
        raise ProtocolRefused("agent_reported_failure")
    if result.output is None:
        raise ProtocolRefused()
    return result.output


def legacy_accounting_view(value: object) -> LegacyAccountingView:
    try:
        return LegacyAccountingView.model_validate(value)
    except ValueError, TypeError:
        raise ProtocolRefused() from None
