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

import asyncio
import json
import zlib
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

    async def simulate_rollback(self, action_type: str, definition: dict[str, Any]) -> WriteResult:
        """Simulate a rollback without mutating (M3.5: the rollback engine
        is itself dry-run-able). Raise WriteRefused rather than guess."""

    async def execute_rollback(self, action_type: str, definition: dict[str, Any]) -> WriteResult:
        """Execute Sudhaar's stored rollback definition. Raise WriteRefused
        rather than guess."""

    async def verify(self, action_type: str, parameters: dict[str, Any]) -> list[dict[str, Any]]:
        """Re-run the checks the remediation targeted (M3.7). Returns the
        checks with their outcomes; never estate values. Raise WriteRefused
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

    async def simulate_rollback(self, action_type: str, definition: dict[str, Any]) -> WriteResult:
        return await self._call(
            {"op": "rollback", "simulate": True, "action_type": action_type, "rollback": definition}
        )

    async def execute_rollback(self, action_type: str, definition: dict[str, Any]) -> WriteResult:
        return await self._call(
            {
                "op": "rollback",
                "simulate": False,
                "action_type": action_type,
                "rollback": definition,
            }
        )

    async def verify(self, action_type: str, parameters: dict[str, Any]) -> list[dict[str, Any]]:
        response = await self._call_raw(
            {"op": "verify", "action_type": action_type, "parameters": parameters}
        )
        checks = response.get("checks")
        if not isinstance(checks, list) or len(checks) > 100:
            raise WriteRefused("write_response_invalid")
        for check in checks:
            if (
                not isinstance(check, dict)
                or not isinstance(check.get("check_id"), str)
                or not check["check_id"]
                or len(check["check_id"]) > 120
                or not all(c.isalnum() or c in "._:/-" for c in check["check_id"])
                or check.get("outcome") not in ("passed", "failed")
            ):
                raise WriteRefused("write_response_invalid")
        return [
            {
                "check_id": check["check_id"],
                "outcome": check["outcome"],
                **({"detail": str(check["detail"])[:200]} if "detail" in check else {}),
            }
            for check in checks
        ]

    async def _call_raw(self, body: dict[str, Any]) -> dict[str, Any]:
        try:
            # httpx's per-I/O timeout alone allows an indefinitely trickling body.
            async with asyncio.timeout(WRITE_TIMEOUT_SECONDS):
                async with httpx.AsyncClient(
                    timeout=WRITE_TIMEOUT_SECONDS, follow_redirects=False
                ) as client:
                    async with client.stream(
                        "POST",
                        f"{self._origin}/writes",
                        json=body,
                        headers={
                            "Authorization": f"Bearer {self._token}",
                            "Content-Type": "application/json",
                            "Accept-Encoding": "gzip, deflate",
                        },
                    ) as response:
                        if response.status_code != 200:
                            raise WriteRefused("write_refused_by_target")
                        declared = response.headers.get("content-length")
                        if declared is not None and declared.isascii() and declared.isdecimal():
                            # Compare numeric strings without parsing attacker-sized integers.
                            size, limit = declared.lstrip("0") or "0", str(MAX_RESPONSE_BYTES)
                            if len(size) > len(limit) or (len(size) == len(limit) and size > limit):
                                raise WriteRefused("write_response_too_large")
                        encoding = (
                            response.headers.get("content-encoding", "identity").strip().lower()
                        )
                        if encoding not in ("identity", "gzip", "deflate"):
                            raise WriteRefused("write_response_unreadable")
                        decoder = (
                            zlib.decompressobj(
                                16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
                            )
                            if encoding != "identity"
                            else None
                        )
                        first_decode = True
                        content = bytearray()
                        wire_size = 0
                        # httpx aiter_bytes inflates a complete chunk BEFORE callers
                        # can inspect its size. Read raw bytes and budget inflation
                        # itself, including a one-byte overflow probe.
                        async for raw in response.aiter_raw():
                            wire_size += len(raw)
                            if wire_size > MAX_RESPONSE_BYTES:
                                raise WriteRefused("write_response_too_large")
                            remaining = MAX_RESPONSE_BYTES - len(content)
                            if decoder is None:
                                chunk = raw
                            else:
                                try:
                                    try:
                                        chunk = decoder.decompress(raw, remaining + 1)
                                    except zlib.error:
                                        # Match httpx's compatibility with raw deflate
                                        # on the first decode, preserving the same bound.
                                        if encoding != "deflate" or not first_decode:
                                            raise
                                        decoder = zlib.decompressobj(-zlib.MAX_WBITS)
                                        chunk = decoder.decompress(raw, remaining + 1)
                                except zlib.error:
                                    raise WriteRefused("write_response_unreadable") from None
                                first_decode = False
                                if decoder.unused_data:
                                    raise WriteRefused("write_response_unreadable")
                            if len(chunk) > remaining:
                                raise WriteRefused("write_response_too_large")
                            content.extend(chunk)
                        if decoder is not None and not decoder.eof:
                            raise WriteRefused("write_response_unreadable")
        except (httpx.HTTPError, TimeoutError):
            raise WriteRefused("write_transport_unavailable") from None
        try:
            payload = json.loads(content)
        except (ValueError, UnicodeError, RecursionError):
            raise WriteRefused("write_response_unreadable") from None
        if not isinstance(payload, dict):
            raise WriteRefused("write_response_unreadable")
        return payload

    async def _call(self, body: dict[str, Any]) -> WriteResult:
        payload = await self._call_raw(body)
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
        return WriteResult(rows_affected=rows, pre_state_ref=pre_ref, post_state_ref=post_ref)
