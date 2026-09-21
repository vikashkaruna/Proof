import json
from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

from axiom.connector_contracts import ReadConnector, WriteConnector, WriteInvocation
from axiom.connector_registry import build_registry, load_descriptor

CATALOGUE = Path(__file__).resolve().parents[3] / "services/bff/src/connectors/descriptors"


def source(name="production"):
    return (CATALOGUE / f"postgresql-{name}.yaml").read_text()


def test_shared_catalogue_contracts():
    registry = build_registry([source(), source("reference")])
    assert len(registry) == 2
    assert load_descriptor(source()).capabilities.write.requiresApprovalToken is True
    assert load_descriptor(source("reference")).capabilities.write is None
    assert "read" not in WriteConnector.__dict__
    assert "execute" not in ReadConnector.__dict__


@pytest.mark.parametrize(
    "patch",
    [
        {"targetBinding": "sandbox"},
        {"auth": "legacy_static"},
        {"assurance": "low"},
        {"version": "latest"},
        {"schemaVersion": True},
        {"capabilities": {"enumerate": {"operation": "sql.read", "mutating": 0}}},
        {"password": "secret"},
        {"capabilities": {"enumerate": {"operation": "DROP TABLE secrets", "mutating": False}}},
        {"rateLimit": {"requestsPerSecond": 0, "burst": 1}},
    ],
)
def test_invalid_manifests(patch):
    descriptor = load_descriptor(source()).model_dump(exclude_none=True)
    with pytest.raises(ValidationError):
        load_descriptor(json.dumps(descriptor | patch))


@pytest.mark.parametrize(
    "text", ["a: 1\na: 2", "a: &x {}\nb: *x", "a: !custom foo", "---\na: 1\n---\nb: 2", "x" * 65537]
)
def test_invalid_yaml(text):
    with pytest.raises((ValueError, yaml.YAMLError), match=r".+"):
        load_descriptor(text)


def test_duplicate_version():
    with pytest.raises(ValueError, match="Duplicate"):
        build_registry([source(), source()])


def test_nonproduction_write_context_refused():
    with pytest.raises(ValidationError):
        WriteInvocation(
            tenant_id="t",
            estate_id="e",
            system_id="s",
            connector_id="c",
            descriptor_sha256="pin",
            grant_id="g",
            workload_identity="w",
            correlation_id="r",
            deadline="d",
            approval_token="a",
            action_id="a",
            batch_id="b",
            target_binding="sandbox",
        )


def test_common_yaml_scalars():
    assert load_descriptor(source().replace("target: postgresql", "target: on")).target == "on"
    with pytest.raises(ValueError, match="decimal integers"):
        load_descriptor(source().replace("burst: 10", "burst: 010"))
