"""Enum modernization preserves existing text and JSON/signature inputs."""

import json
from enum import Enum

import pytest

from axiom.agents.base import AgentName, AuditCompletionError, AuditCompletionFailed, AutonomyLevel
from axiom.agents.pramaan import DossierStatus, DossierType
from axiom.agents.prativedan import ReportKind
from axiom.control_library_loader import (
    ControlDomain,
    ControlSeverity,
    EvidenceType,
    MappingProvenance,
    MappingStrength,
)


@pytest.mark.parametrize("enum_type", [AgentName, AutonomyLevel, DossierStatus, DossierType, ReportKind, ControlDomain, ControlSeverity, EvidenceType, MappingProvenance, MappingStrength])
def test_existing_enum_text_format_and_json_contracts(enum_type: type[Enum]) -> None:
    for member in enum_type:
        qualified = f"{enum_type.__name__}.{member.name}"
        assert isinstance(member, str)
        assert str(member) == qualified
        assert format(member, ">40") == format(qualified, ">40")
        assert json.dumps(member) == json.dumps(member.value)
        assert member == member.value
        assert hash(member) == hash(member.value)
        assert enum_type(member.value) is member


def test_existing_audit_exception_import_retains_identical_catch_type() -> None:
    assert AuditCompletionFailed is AuditCompletionError
    with pytest.raises(AuditCompletionFailed):
        raise AuditCompletionError("audit refused")
