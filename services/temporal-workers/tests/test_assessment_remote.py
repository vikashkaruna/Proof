"""Keyless remote transport boundaries; test tokens are explicitly synthetic."""

import asyncio
import json
import ssl
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from temporal_workers import assessment_remote
from temporal_workers.assessment_activity import PrivateAssessmentController
from temporal_workers.assessment_remote import (
    GoogleMetadataIdentity,
    RemoteAssessmentController,
    RemoteAssessmentControllerActivity,
)
from temporal_workers.worker import assessment_options
from temporalio.exceptions import ApplicationError

ORIGIN = "https://controller.example.run.app"
SYNTHETIC = "synthetic.identity.signature"


def install_transport(monkeypatch, respond):
    actual_client = httpx.AsyncClient
    calls = []

    def client(**options):
        calls.append(options)
        return actual_client(**options, transport=httpx.MockTransport(respond))

    monkeypatch.setattr(assessment_remote.httpx, "AsyncClient", client)
    return calls


async def test_keyless_metadata_identity_and_signed_application_header(monkeypatch):
    requests = []

    def respond(request):
        requests.append(request)
        if request.url.host == "metadata.google.internal":
            assert request.headers["metadata-flavor"] == "Google"
            assert request.url.params["audience"] == ORIGIN
            assert request.url.params["format"] == "full"
            assert (
                request.url.path
                == "/computeMetadata/v1/instance/service-accounts/default/identity"
            )
            return httpx.Response(
                200, text=SYNTHETIC, headers={"Metadata-Flavor": "Google"}
            )
        assert request.url.host == "controller.example.run.app"
        assert request.url.path == "/assessment/scheduling/poll"
        assert request.headers.get("authorization") == request.headers.get(
            "x-serverless-authorization"
        )
        assert (request.headers.get("authorization") == f"Bearer {SYNTHETIC}") is True
        assert json.loads(request.content) == {}
        return httpx.Response(200, json={"jobs": []})

    options = install_transport(monkeypatch, respond)
    assert await RemoteAssessmentController(ORIGIN).request("scheduling/poll", {}) == {
        "jobs": []
    }
    assert len(requests) == 2
    assert all(
        c["trust_env"] is False and c["follow_redirects"] is False for c in options
    )
    assert options[1]["verify"].verify_mode == ssl.CERT_REQUIRED
    assert options[1]["verify"].check_hostname


@pytest.mark.parametrize(
    "fault", ["redirect", "status", "header", "oversized", "invalid", "timeout"]
)
async def test_metadata_failures_are_bounded_sanitized_and_never_reach_controller(
    monkeypatch, fault
):
    requests = []

    def respond(request):
        requests.append(request)
        if fault == "timeout":
            raise httpx.ReadTimeout("private-marker")
        return httpx.Response(
            302 if fault == "redirect" else 500 if fault == "status" else 200,
            text="x" * 8193
            if fault == "oversized"
            else "private-marker"
            if fault == "invalid"
            else SYNTHETIC,
            headers={} if fault == "header" else {"Metadata-Flavor": "Google"},
        )

    install_transport(monkeypatch, respond)
    with pytest.raises(ValueError, match="Scheduler identity unavailable") as caught:
        await GoogleMetadataIdentity().token(ORIGIN)
    assert caught.value.__context__ is None and caught.value.__cause__ is None
    assert len(requests) == 1
    assert requests[0].url.host == "metadata.google.internal"


@pytest.mark.parametrize(
    "fault", ["redirect", "status", "oversized", "invalid", "timeout"]
)
async def test_remote_activity_never_retries_or_serializes_transport_failure(
    monkeypatch, fault
):
    requests = []
    job = {"tenantId": str(uuid4()), "jobId": str(uuid4())}

    def respond(request):
        requests.append(request)
        if fault == "timeout":
            raise httpx.ReadTimeout("private-marker")
        return httpx.Response(
            302 if fault == "redirect" else 500 if fault == "status" else 200,
            text="x" * 4097 if fault == "oversized" else "private-marker",
        )

    install_transport(monkeypatch, respond)
    identity = SimpleNamespace(token=AsyncMock(return_value=SYNTHETIC))
    with pytest.raises(ApplicationError) as caught:
        await RemoteAssessmentControllerActivity(ORIGIN, identity).invoke(job, "run")
    assert str(caught.value) == "assessment_unconfirmed: assessment_unconfirmed"
    assert caught.value.__context__ is None and caught.value.__cause__ is None
    assert caught.value.non_retryable
    assert len(requests) == 1
    identity.token.assert_awaited_once_with(ORIGIN)


@pytest.mark.parametrize(
    "operation,payload",
    [
        ("arbitrary", {}),
        (
            "run",
            {
                "tenantId": str(uuid4()),
                "jobId": str(uuid4()),
                "input": "private-marker",
            },
        ),
        ("scheduling/poll", {"tenantId": str(uuid4())}),
        ("scheduling/ack", {"input": "private-marker"}),
    ],
)
async def test_payload_is_rejected_before_identity_lookup_or_network(
    monkeypatch, operation, payload
):
    identity = SimpleNamespace(token=AsyncMock(return_value=SYNTHETIC))
    network = install_transport(monkeypatch, lambda _: httpx.Response(200))
    remote = RemoteAssessmentController(ORIGIN, identity)
    local = PrivateAssessmentController("/tmp/synthetic.sock", 0)
    for controller in (remote, local):
        with pytest.raises(ValueError, match="Private controller unavailable"):
            await controller.request(operation, payload)
    identity.token.assert_not_called()
    assert not network


@pytest.mark.parametrize(
    "value",
    [
        "http://controller.invalid",
        "https://controller.invalid/",
        "https://controller.invalid/path",
        "https://controller.invalid?query",
        "https://user:password@controller.invalid",
        "https://controller.invalid#fragment",
        "https://controller.invalid:443",
        "https://controller.invalid:99999",
        "https://CONTROLLER.invalid",
        "https://controller.invalid\n",
        "https://cöntroller.invalid",
    ],
)
def test_ambiguous_insecure_origins_are_refused(value):
    with pytest.raises(ValueError):
        RemoteAssessmentController(value)


def test_disabling_certificate_or_hostname_verification_is_refused():
    context = ssl.create_default_context()
    context.check_hostname = False
    with pytest.raises(ValueError, match="TLS verification required"):
        RemoteAssessmentController(ORIGIN, tls=context)
    context.verify_mode = ssl.CERT_NONE
    with pytest.raises(ValueError, match="TLS verification required"):
        RemoteAssessmentController(ORIGIN, tls=context)


async def test_request_cancellation_propagates(monkeypatch):
    identity = SimpleNamespace(token=AsyncMock(side_effect=asyncio.CancelledError()))
    network = install_transport(monkeypatch, lambda _: httpx.Response(200))
    with pytest.raises(asyncio.CancelledError):
        await RemoteAssessmentController(ORIGIN, identity).request(
            "scheduling/poll", {}
        )
    assert not network


def test_remote_cli_mode_is_explicit_and_preserves_legacy_default():
    assert assessment_options([]) == (None, False)
    controller, pump = assessment_options(
        ["--assessment-controller-origin", ORIGIN, "--assessment-outbox-pump"]
    )
    assert isinstance(controller, RemoteAssessmentControllerActivity) and pump
    assert isinstance(controller.identity, GoogleMetadataIdentity)


@pytest.mark.parametrize(
    "args",
    [
        ["--assessment-outbox-pump"],
        ["--assessment-controller-uid", "0"],
        ["--assessment-controller-origin", ORIGIN, "--assessment-controller-uid", "0"],
        [
            "--assessment-controller-origin",
            ORIGIN,
            "--assessment-controller-socket",
            "/tmp/synthetic.sock",
        ],
    ],
)
def test_remote_cli_refuses_mixed_or_incomplete_modes(args):
    with pytest.raises(SystemExit):
        assessment_options(args)
