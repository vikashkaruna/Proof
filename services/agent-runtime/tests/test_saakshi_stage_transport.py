"""Internal protocol boundaries only; fixture metadata is not provider acceptance."""

import json
import time
from datetime import UTC, datetime

import httpx
import pytest
from test_saakshi_staging import OPERATION, PEER_KEY, SOURCE_KEY, receipt, source

from axiom.saakshi_dispatch import PreparedEvidenceDispatch
from axiom.saakshi_stage_transport import InternalEvidenceStageTransport
from axiom.saakshi_staging import SignedEvidenceStageRequest, verify_evidence_stage_request

RUN = "50000000-0000-4000-8000-000000000119"


class Chunks(httpx.AsyncByteStream):
    def __init__(self, parts):
        self.parts = parts

    async def __aiter__(self):
        for part in self.parts:
            yield part


def prepared():
    return PreparedEvidenceDispatch(
        source(), RUN, OPERATION, "123", int(time.time() * 1000) + 60000
    )


def transport(handler, **changes):
    return InternalEvidenceStageTransport(
        stage_url="http://127.0.0.1/internal/staged-evidence/stage",
        peer_secret=PEER_KEY,
        source_secret=SOURCE_KEY,
        transport=httpx.MockTransport(handler),
        **changes,
    )


@pytest.mark.asyncio
async def test_source_signed_exact_metadata_has_no_bytes_or_provider_keys():
    seen = []

    async def handler(request):
        seen.append(request)
        signed = SignedEvidenceStageRequest.model_validate_json(request.content)
        s, c, d = verify_evidence_stage_request(signed, SOURCE_KEY, peer_secret=PEER_KEY)
        assert s == source()
        assert c == OPERATION
        assert str(d.run_id) == RUN
        assert request.headers["authorization"] == "Bearer " + PEER_KEY
        body = (
            receipt(correlation_id=OPERATION, readback_at=datetime.now(UTC).isoformat())
            .model_dump_json()
            .encode()
        )
        return httpx.Response(200, stream=Chunks([body[:20], body[20:]]))

    result = await transport(handler).port(prepared()).stage(source(), OPERATION)
    assert result.version_id == "actual-version-id"
    assert len(seen) == 1
    assert b"contentBase64" not in seen[0].content
    assert SOURCE_KEY.encode() not in seen[0].content


@pytest.mark.parametrize(
    "kind", ["declared", "absent", "lying", "compressed", "redirect", "badjson"]
)
@pytest.mark.asyncio
async def test_refuses_unbounded_or_unconfirmed_response(kind):
    async def handler(request):
        body = b"x" * 32001
        headers = {}
        status = 200
        if kind == "declared":
            headers["content-length"] = "32001"
        if kind == "lying":
            headers["content-length"] = "2"
        if kind == "compressed":
            headers["content-encoding"] = "gzip"
        if kind == "redirect":
            status = 307
            headers["location"] = "http://foreign.invalid"
        if kind == "badjson":
            body = json.dumps({"secret": "provider-diagnostic"}).encode()
        return httpx.Response(status, headers=headers, stream=Chunks([body[:16000], body[16000:]]))

    with pytest.raises(ValueError, match="Evidence staging is unconfirmed"):
        await transport(handler).port(prepared()).stage(source(), OPERATION)


@pytest.mark.asyncio
async def test_expired_prepared_lease_never_sends_internal_request():
    seen = []

    async def handler(request):
        seen.append(request)
        return httpx.Response(200)

    p = prepared()
    p = PreparedEvidenceDispatch(p.source, p.run_id, p.correlation_id, p.requested_receipt, 1)
    with pytest.raises(ValueError, match="Evidence staging is unconfirmed"):
        await transport(handler).port(p).stage(source(), OPERATION)
    assert seen == []


@pytest.mark.parametrize(
    "changes",
    [
        {"source_secret": PEER_KEY},
        {"source_secret": "tiny"},
        {"stage_url": "http://public.invalid/other"},
        {"stage_url": "http://user:password@internal/internal/staged-evidence/stage"},
        {"stage_url": "http://internal/internal/staged-evidence/stage?url=foreign"},
    ],
)
def test_configuration_never_creates_broad_or_shared_key_transport(changes):
    config = {
        "stage_url": "http://127.0.0.1/internal/staged-evidence/stage",
        "peer_secret": PEER_KEY,
        "source_secret": SOURCE_KEY,
    }
    config.update(changes)
    with pytest.raises(ValueError, match="configuration is unavailable"):
        InternalEvidenceStageTransport(**config)
