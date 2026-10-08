"""Actual httpx transport/stream boundaries; never a live estate target."""

import gzip
import json

import httpx
import pytest

import axiom.write_adapters as module
from axiom.write_adapters import MAX_RESPONSE_BYTES, ReferenceWriteAdapter, WriteRefused


class Stream(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks
        self.reads = 0
        self.closed = False

    async def __aiter__(self):
        for chunk in self.chunks:
            self.reads += 1
            yield chunk

    async def aclose(self):
        self.closed = True


def adapter(monkeypatch, body, headers=None, status=200):
    client_type = httpx.AsyncClient
    stream = Stream(body)
    seen = []

    async def target(request):
        seen.append(request)
        return httpx.Response(status, headers=headers or {}, stream=stream)

    monkeypatch.setattr(
        module.httpx,
        "AsyncClient",
        lambda **options: client_type(**options, transport=httpx.MockTransport(target)),
    )
    return ReferenceWriteAdapter("https://reference-mock.invalid", "test-placeholder"), stream, seen


async def call(value, operation):
    if operation == "verify":
        return await value.verify("policy.publish", {})
    if operation == "rollback":
        return await value.execute_rollback("policy.publish", {})
    if operation == "simulate":
        return await value.simulate_rollback("policy.publish", {})
    return await value.execute("policy.publish", {})


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["execute", "verify", "rollback", "simulate"])
@pytest.mark.parametrize("headers", [{}, {"content-length": "1"}])
async def test_chunked_or_lying_length_is_refused_before_consuming_tail(
    monkeypatch, operation, headers
):
    valid = b'{"rows_affected":1,"checks":[],"padding":"'
    value, stream, _ = adapter(
        monkeypatch, [valid, b"a" * MAX_RESPONSE_BYTES, b'"}', b" " * 65536], headers
    )
    with pytest.raises(WriteRefused, match="write_response_too_large"):
        await call(value, operation)
    assert stream.reads < 4
    assert stream.closed


@pytest.mark.asyncio
async def test_oversized_declared_length_refuses_without_reading_body(monkeypatch):
    value, stream, _ = adapter(
        monkeypatch, [b'{"rows_affected":1}'], {"content-length": str(MAX_RESPONSE_BYTES + 1)}
    )
    with pytest.raises(WriteRefused, match="write_response_too_large"):
        await value.execute("policy.publish", {})
    assert stream.reads == 0
    assert stream.closed


@pytest.mark.asyncio
async def test_decoded_gzip_bound_cannot_be_bypassed_by_small_wire_body(monkeypatch):
    data = json.dumps({"rows_affected": 1, "padding": "a" * MAX_RESPONSE_BYTES}).encode()
    compressed = gzip.compress(data)
    value, stream, _ = adapter(
        monkeypatch,
        [compressed],
        {"content-encoding": "gzip", "content-length": str(len(compressed))},
    )
    with pytest.raises(WriteRefused, match="write_response_too_large"):
        await value.execute("policy.publish", {})
    assert stream.closed


@pytest.mark.asyncio
async def test_exact_limit_valid_json_is_accepted_without_changing_schema(monkeypatch):
    prefix = b'{"rows_affected":1,"padding":"'
    data = prefix + b"a" * (MAX_RESPONSE_BYTES - len(prefix) - 2) + b'"}'
    assert len(data) == MAX_RESPONSE_BYTES
    value, stream, seen = adapter(monkeypatch, [data])
    result = await value.execute("policy.publish", {})
    assert result.rows_affected == 1
    assert stream.closed
    assert seen[0].headers["Authorization"] == "Bearer test-placeholder"


@pytest.mark.asyncio
async def test_response_refusal_never_claims_successful_mutation_or_rollback(monkeypatch):
    value, _, _ = adapter(monkeypatch, [b"client-personal-secret"], status=500)
    with pytest.raises(WriteRefused) as failure:
        await value.execute_rollback("policy.publish", {})
    assert str(failure.value) == "write_refused_by_target"
    assert "client-personal-secret" not in str(failure.value)


@pytest.mark.asyncio
async def test_total_stream_deadline_is_enforced_and_sanitized(monkeypatch):
    import asyncio

    client_type = httpx.AsyncClient
    closed = []

    class SlowStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'{"rows_affected":'
            await asyncio.sleep(1)
            yield b"1}"

        async def aclose(self):
            closed.append(True)

    async def target(request):
        return httpx.Response(200, stream=SlowStream())

    monkeypatch.setattr(module, "WRITE_TIMEOUT_SECONDS", 0.02)
    monkeypatch.setattr(
        module.httpx,
        "AsyncClient",
        lambda **options: client_type(**options, transport=httpx.MockTransport(target)),
    )
    with pytest.raises(WriteRefused, match="write_transport_unavailable"):
        await ReferenceWriteAdapter("https://reference-mock.invalid", "test-placeholder").execute(
            "policy.publish", {}
        )
    assert closed


@pytest.mark.asyncio
async def test_attacker_sized_length_is_refused_without_integer_conversion(monkeypatch):
    value, stream, _ = adapter(
        monkeypatch, [b'{"rows_affected":1}'], {"content-length": "9" * 5000}
    )
    with pytest.raises(WriteRefused, match="write_response_too_large"):
        await value.execute("policy.publish", {})
    assert stream.reads == 0


@pytest.mark.asyncio
async def test_midstream_transport_error_is_sanitized_and_closed(monkeypatch):
    client_type = httpx.AsyncClient
    closed = []

    class BrokenStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'{"rows_affected":'
            raise httpx.ReadError("client-personal-secret in target diagnostic")

        async def aclose(self):
            closed.append(True)

    async def target(request):
        return httpx.Response(200, stream=BrokenStream())

    monkeypatch.setattr(
        module.httpx,
        "AsyncClient",
        lambda **options: client_type(**options, transport=httpx.MockTransport(target)),
    )
    with pytest.raises(WriteRefused) as error:
        await ReferenceWriteAdapter(
            "https://reference-mock.invalid", "test-placeholder"
        ).execute_rollback("policy.publish", {})
    assert str(error.value) == "write_transport_unavailable"
    assert "client-personal-secret" not in str(error.value)
    assert closed


@pytest.mark.asyncio
async def test_nested_unreadable_json_refuses_without_provider_diagnostics(monkeypatch):
    value, stream, _ = adapter(
        monkeypatch, [b"[" * 2000 + b'"client-personal-secret"' + b"]" * 2000]
    )
    with pytest.raises(WriteRefused) as error:
        await value.execute("policy.publish", {})
    assert str(error.value) == "write_response_unreadable"
    assert stream.closed
