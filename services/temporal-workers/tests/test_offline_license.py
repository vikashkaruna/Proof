"""A sovereign worker must stop polling when its license becomes invalid."""

import asyncio
from unittest.mock import patch

import pytest
from temporal_workers.worker import main, onprem_license_valid, watch_onprem_license


def test_worker_refuses_absent_onprem_license():
    with patch.dict("os.environ", {"ENVIRONMENT": "onprem"}, clear=True):
        assert not onprem_license_valid()
    with patch.dict("os.environ", {"ENVIRONMENT": "production"}, clear=True):
        assert onprem_license_valid()


@pytest.mark.asyncio
async def test_running_worker_monitor_stops_after_expiry(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "onprem")
    monkeypatch.setenv("AXIOM_OFFLINE_LICENSE", "invalid")

    async def no_wait(_seconds):
        return None

    monkeypatch.setattr(asyncio, "sleep", no_wait)
    with pytest.raises(RuntimeError, match="offline_license_invalid"):
        await watch_onprem_license()


@pytest.mark.asyncio
async def test_worker_refuses_boot_before_listening(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "onprem")
    monkeypatch.delenv("AXIOM_OFFLINE_LICENSE", raising=False)
    with pytest.raises(RuntimeError, match="offline_license_invalid"):
        await main()
