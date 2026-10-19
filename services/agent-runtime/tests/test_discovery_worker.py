"""Dedicated Drishti compute has no target/database credentials or network client."""

from unittest.mock import Mock

import pytest

from axiom import discovery_worker as worker

TENANT = "73730000-0000-4000-8000-000000000001"
REQUEST = "73730000-0000-4000-8000-000000000002"
RUN = "73730000-0000-4000-8000-000000000003"


def test_private_svid_is_only_in_tool_frame(monkeypatch):
    frames = []
    monkeypatch.setattr(worker, "write_frame", frames.append)
    monkeypatch.setattr(
        worker,
        "read_frame",
        lambda: {"ok": True, "value": {"requestId": REQUEST, "discoveryRunId": RUN}},
    )
    identity = Mock(return_value="private-synthetic-proof")
    worker.discover({"tenantId": TENANT, "requestId": REQUEST}, identity)
    identity.assert_called_once_with()
    assert frames[0] == {
        "tool": "discovery.read",
        "request": {
            "tenantId": TENANT,
            "requestId": REQUEST,
            "workloadProof": "private-synthetic-proof",
        },
    }
    assert frames[1] == {"result": {"requestId": REQUEST, "discoveryRunId": RUN}}
    assert "private-synthetic-proof" not in str(frames[1])


@pytest.mark.parametrize("extra", ["endpoint", "password", "workloadProof", "spiffeId"])
def test_untrusted_assignment_cannot_supply_authority(extra):
    identity = Mock()
    with pytest.raises(ValueError, match="Discovery assignment refused"):
        worker.discover({"tenantId": TENANT, "requestId": REQUEST, extra: "unsafe"}, identity)
    identity.assert_not_called()


def test_foreign_retained_receipt_refused(monkeypatch):
    monkeypatch.setattr(worker, "write_frame", lambda _: None)
    monkeypatch.setattr(
        worker,
        "read_frame",
        lambda: {"ok": True, "value": {"requestId": TENANT, "discoveryRunId": RUN}},
    )
    with pytest.raises(ValueError, match="Discovery read unavailable"):
        worker.discover({"tenantId": TENANT, "requestId": REQUEST}, lambda: "synthetic")
