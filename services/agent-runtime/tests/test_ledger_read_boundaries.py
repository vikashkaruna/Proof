"""Malformed transport replies cannot establish ledger integrity or records."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from axiom.ledger_client import LedgerClient


def reader(data: object) -> LedgerClient:
    query = Mock()
    for operation in ("select", "eq", "order", "limit"):
        getattr(query, operation).return_value = query
    query.execute.return_value = SimpleNamespace(data=data)
    client = Mock()
    client.rpc.return_value = query
    client.table.return_value = query
    return LedgerClient(read_client=client)


@pytest.mark.asyncio
@pytest.mark.parametrize("data", [None, {}, False, "", [None], [{"sequence_no": True, "reason": "break"}], [{"sequence_no": 1, "reason": None}], [{"sequence_no": 0, "reason": "break"}], [{"sequence_no": -1, "reason": "break"}], [{"sequence_no": 1, "reason": " "}]])
async def test_unproven_verification_never_reports_intact(data: object) -> None:
    with pytest.raises(RuntimeError, match="verification response was refused"):
        await reader(data).verify("tenant-a")


@pytest.mark.asyncio
async def test_empty_verified_break_list_is_intact_and_genuine_break_is_retained() -> None:
    assert await reader([]).verify("tenant-a") == {"intact": True}
    assert await reader([{"sequence_no": 3, "reason": "chain mismatch"}]).verify("tenant-a") == {
        "intact": False,
        "firstBreak": {"sequenceNo": 3, "reason": "chain mismatch"},
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("data", [None, {}, False, [None], [{"sequence_no": True}], [{"sequence_no": "3"}], [{}], [{"sequence_no": 0}], [{"sequence_no": -1}], [{"sequence_no": 9223372036854775808}]])
async def test_malformed_query_never_becomes_empty_or_typed_records(data: object) -> None:
    with pytest.raises(RuntimeError, match="query response was refused"):
        await reader(data).query(tenant_id="tenant-a")


@pytest.mark.asyncio
async def test_query_preserves_real_record_without_rewriting_receipt() -> None:
    records = [{"sequence_no": 3, "entry_hash": "recorded", "detail": {"unknown": None}}]
    assert await reader(records).query(tenant_id="tenant-a") == records
    assert await reader([]).query(tenant_id="tenant-a") == []


@pytest.mark.asyncio
async def test_missing_reader_refuses_integrity_and_query() -> None:
    client = LedgerClient()
    with pytest.raises(RuntimeError, match="read capability is unavailable"):
        await client.verify("tenant-a")
    with pytest.raises(RuntimeError, match="read capability is unavailable"):
        await client.query(tenant_id="tenant-a")
