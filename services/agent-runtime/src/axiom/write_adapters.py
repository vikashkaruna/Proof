"""W5 · M3.4/M3.5 — the write-adapter seam and the reference write adapter.

The executor executes through a `WriteAdapter`, never through a connector
credential or a caller-supplied URL. The adapter is bound to the approved
plan by construction: it receives only the action type, parameters and
rollback definition the claim authorises, and returns metadata (a row
count and state digests) — never estate values.

`ReferenceWriteAdapter` is the one shipped implementation: a bounded HTTP
call to the Axiom reference write service (`reference-mock` provenance).
It exists so the executor's and rollback engine's structural guarantees —
scope, digest, idempotency, ledger, halt — are proved end-to-end in CI.
Production connector execution (broker leases against real client
systems) is a separate, operator-gated composition and is deliberately
NOT delivered here; with no write origin configured the executor refuses.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

import httpx

MAX_RESPONSE_BYTES = 1_048_576
WRITE_TIMEOUT_SECONDS = 15.0


@dataclass(frozen=True)
class WriteResult:
    rows_affected: int | None
    pre_state_ref: str | None
    post_state_ref: str | None


class WriteRefused(RuntimeError):  # noqa: N818 — reads as the state it reports
    """The adapter refused to execute. `reason` is a machine-readable code."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class WriteAdapter(Protocol):
    async def execute(self, action_type: str, parameters: dict[str, Any]) -> WriteResult:
        """Execute one approved action. Raise WriteRefused rather than guess."""

    async def simulate_rollback(
        self, action_type: str, definition: dict[str, Any]
    ) -> WriteResult:
        """Simulate a rollback without mutating (M3.5: the rollback engine
        is itself dry-run-able). Raise WriteRefused rather than guess."""

    async def execute_rollback(
        self, action_type: str, definition: dict[str, Any]
    ) -> WriteResult:
        """Execute Sudhaar's stored rollback definition. Raise WriteRefused
        rather than guess."""


class ReferenceWriteAdapter:
    """Bounded write transport to the reference write service.

    Same discipline as the REST read transport: one origin from reviewed
    configuration, no redirects, deadline timeout, JSON under 1 MiB, and a
    response schema that carries only metadata.
    """

    def __init__(self, origin: str, token: str):
        if not origin.startswith(("https://", "http://")):
            raise ValueError("reference write origin must be http(s)")
        self._origin = origin.rstrip("/")
        self._token = token

    async def execute(self, action_type: str, parameters: dict[str, Any]) -> WriteResult:
        return await self._call({"action_type": action_type, "parameters": parameters})

    async def simulate_rollback(
        self, action_type: str, definition: dict[str, Any]
    ) -> WriteResult:
        return await self._call(
            {"op": "rollback", "simulate": True, "action_type": action_type, "rollback": definition}
        )

    async def execute_rollback(
        self, action_type: str, definition: dict[str, Any]
    ) -> WriteResult:
        return await self._call(
            {"op": "rollback", "simulate": False, "action_type": action_type, "rollback": definition}
        )

    async def _call(self, body: dict[str, Any]) -> WriteResult:
        try:
            async with httpx.AsyncClient(
                timeout=WRITE_TIMEOUT_SECONDS, follow_redirects=False
            ) as client:
                response = await client.post(
                    f"{self._origin}/writes",
                    json=body,
                    headers={
                        "Authorization": f"Bearer {self._token}",
                        "Content-Type": "application/json",
                    },
                )
        except httpx.HTTPError:
            raise WriteRefused("write_transport_unavailable") from None
        if response.status_code != 200:
            raise WriteRefused("write_refused_by_target")
        try:
            payload = response.json()
        except ValueError:
            raise WriteRefused("write_response_unreadable") from None
        if not isinstance(payload, dict):
            raise WriteRefused("write_response_unreadable")
        rows = payload.get("rows_affected")
        if rows is not None and (not isinstance(rows, int) or isinstance(rows, bool) or rows < 0):
            raise WriteRefused("write_response_invalid")
        pre_ref = payload.get("pre_state_ref")
        post_ref = payload.get("post_state_ref")
        for ref in (pre_ref, post_ref):
            if ref is not None and (
                not isinstance(ref, str)
                or not ref
                or len(ref) > 512
                or not all(c.isalnum() or c in "._:/-" for c in ref)
            ):
                raise WriteRefused("write_response_invalid")
        return WriteResult(
            rows_affected=rows, pre_state_ref=pre_ref, post_state_ref=post_ref
        )
