"""Reference-only scheduled read consumer; backend authority stays in the controller.

No human identity, target credentials or source payloads are retained here.
Unconfirmed calls are reconciled using the original durable fire reference.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any, Protocol
from uuid import UUID


class MonitoringController(Protocol):
    async def request(self, operation: str, payload: dict[str, Any]) -> Any: ...


def _reference(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {"tenantId", "fireId"}:
        raise ValueError("Scheduled read reference refused")
    for key in value:
        if (
            not isinstance(value[key], str)
            or str(UUID(value[key])) != value[key]
            or UUID(value[key]).int == 0
        ):
            raise ValueError("Scheduled read reference refused")
    return value


def _outcome(value: Any, reference: dict[str, str]) -> None:
    if not isinstance(value, dict) or set(value) != {
        "tenantId",
        "fireId",
        "state",
        "cleanupConfirmed",
        "receiptId",
    }:
        raise ValueError("Scheduled read outcome unavailable")
    if any(value[key] != reference[key] for key in reference) or value["state"] not in (
        "confirmed",
        "unconfirmed",
        "refused",
    ):
        raise ValueError("Scheduled read scope changed")
    cleanup, receipt = value["cleanupConfirmed"], value["receiptId"]
    if cleanup is not None and type(cleanup) is not bool:
        raise TypeError("Scheduled read cleanup unavailable")
    if receipt is not None and (
        not isinstance(receipt, str)
        or not receipt.isascii()
        or not receipt.isdigit()
        or receipt.startswith("0")
        or len(receipt) > 19
        or int(receipt) > 9223372036854775807
    ):
        raise ValueError("Scheduled read receipt unavailable")
    if value["state"] == "confirmed" and (cleanup is not True or receipt is None):
        raise ValueError("Scheduled read supervision unconfirmed")


class MonitoringReadPump:
    def __init__(
        self,
        controller: MonitoringController,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ):
        self.controller = controller
        self.sleep = sleep

    async def once(self) -> None:
        value = await self.controller.request("monitoring/poll", {})
        if (
            not isinstance(value, dict)
            or set(value) != {"fires"}
            or not isinstance(value["fires"], list)
            or len(value["fires"]) > 1
        ):
            raise ValueError("Scheduled read queue unavailable")
        for raw in value["fires"]:
            reference = _reference(raw)
            try:
                result = await self.controller.request("monitoring/run", reference)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - an uncertain launch is read back, never repeated.
                result = await self.controller.request(
                    "monitoring/reconcile", reference
                )
            _outcome(result, reference)

    async def run(self) -> None:
        while True:
            try:
                await self.once()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - keep backend details and credentials out of logs.
                logging.getLogger(__name__).warning("monitoring_read.poll_unconfirmed")
            await self.sleep(10)
