"""Mounted scheduled-read pump accepts opaque references and never retries a launch."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from temporal_workers.monitoring_reads import MonitoringReadPump


def reference():
    return {"tenantId": str(uuid4()), "fireId": str(uuid4())}


def outcome(ref):
    return ref | {"state": "confirmed", "cleanupConfirmed": True, "receiptId": "12"}


async def test_poll_and_dispatch_have_only_durable_references():
    ref = reference()
    control = SimpleNamespace(
        request=AsyncMock(side_effect=[{"fires": [ref]}, outcome(ref)])
    )
    await MonitoringReadPump(control).once()
    assert control.request.call_args_list[0].args == ("monitoring/poll", {})
    assert control.request.call_args_list[1].args == ("monitoring/run", ref)


async def test_lost_reply_only_reads_original_outcome_never_repeats_run():
    ref = reference()
    control = SimpleNamespace(
        request=AsyncMock(
            side_effect=[{"fires": [ref]}, ValueError("Unavailable"), outcome(ref)]
        )
    )
    await MonitoringReadPump(control).once()
    assert [call.args[0] for call in control.request.call_args_list] == [
        "monitoring/poll",
        "monitoring/run",
        "monitoring/reconcile",
    ]
    assert control.request.call_args.args[1] == ref


@pytest.mark.parametrize(
    "value",
    [
        {"fires": [reference(), reference()]},
        {"fires": [reference() | {"actorId": str(uuid4())}]},
        {"fires": [], "credentials": "synthetic-private-marker"},
    ],
)
async def test_malformed_or_private_queue_never_launches(value):
    control = SimpleNamespace(request=AsyncMock(return_value=value))
    with pytest.raises(ValueError):
        await MonitoringReadPump(control).once()
    assert control.request.call_count == 1


@pytest.mark.parametrize(
    "changed",
    [
        {"cleanupConfirmed": False},
        {"fireId": str(uuid4())},
        {"receiptId": "9999999999999999999"},
        {"receiptId": "１２"},
        {"cleanupConfirmed": 1},
    ],
)
async def test_unbound_or_unsupervised_result_cannot_be_confirmed(changed):
    ref = reference()
    control = SimpleNamespace(
        request=AsyncMock(side_effect=[{"fires": [ref]}, outcome(ref) | changed])
    )
    with pytest.raises((ValueError, TypeError)):
        await MonitoringReadPump(control).once()
    assert control.request.call_count == 2


async def test_cancelled_run_is_not_retried_or_masked():
    ref = reference()
    control = SimpleNamespace(
        request=AsyncMock(side_effect=[{"fires": [ref]}, asyncio.CancelledError()])
    )
    with pytest.raises(asyncio.CancelledError):
        await MonitoringReadPump(control).once()
    assert control.request.call_count == 2


def test_monitoring_flag_is_explicit_and_requires_private_local_transport():
    from temporal_workers.worker import assessment_options, monitoring_read_options

    assert monitoring_read_options([]) is False
    for argv in (
        ["--monitoring-read-pump"],
        [
            "--monitoring-read-pump",
            "--assessment-controller-origin",
            "https://controller.test.invalid",
        ],
    ):
        with pytest.raises(SystemExit):
            assessment_options(argv)
    argv = [
        "--monitoring-read-pump",
        "--assessment-controller-socket",
        "/run/assessment-controller/controller.sock",
        "--assessment-controller-uid",
        "20103",
    ]
    controller, _pump = assessment_options(argv)
    assert controller is not None and monitoring_read_options(argv) is True


def test_private_transport_rejects_private_fields_on_monitoring_operations():
    from temporal_workers.assessment_contracts import transport_payload

    ref = reference()
    assert transport_payload("monitoring/run", ref) == ref
    assert transport_payload("monitoring/poll", {}) == {}
    for operation, value in (
        ("monitoring/run", ref | {"actorId": str(uuid4())}),
        ("monitoring/poll", {"tenantId": ref["tenantId"]}),
    ):
        with pytest.raises(ValueError):
            transport_payload(operation, value)
