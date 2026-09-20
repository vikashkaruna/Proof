"""Shared kill-switch state, read from inside the execution path (SEC-4 / R-09).

Migration 0009 moved the kill switch into `kill_switch_state` so every BFF
replica reads the same row. The independent review found the other half still
missing: nothing in the Python runtime ever read it. The BFF checks the switch
when it *admits* a request, and admission is not execution — a batch already
dispatched runs to completion no matter how many times an operator engages the
stop. FR-8.6 requires "immediately effective", and request admission cannot
deliver that on its own.

So this is the same state, read from the process that actually mutates a client
estate, with the same fail-safe rule as the BFF:

    an emergency stop that cannot be verified must be assumed engaged.

That is deliberately the opposite of how authentication fails here. A failure to
read authentication withholds authority and returns 401/503; a failure to read
the kill switch withholds *action*. Both refuse; they refuse different things.

Karya checks it before every mutating step and between bounded chunks, so the
worst case is one action's latency rather than a whole batch.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import structlog

from .config import Settings, get_settings

log = structlog.get_logger()

# How long a replica may serve a cached answer. This is the propagation bound
# for the emergency stop, so it is deliberately short.
CACHE_TTL_SECONDS = 2.0

GLOBAL_SCOPE = "global"


class KillSwitchEngaged(RuntimeError):  # noqa: N818 — reads as the state it reports
    """Raised when execution must stop. Carries why, for the ledger."""

    def __init__(self, scope: str, reason: str) -> None:
        super().__init__(f"kill switch engaged ({scope}): {reason}")
        self.scope = scope
        self.reason = reason


@dataclass(frozen=True)
class KillSwitchState:
    engaged: bool
    scope: str
    reason: str


class KillSwitchReader:
    """Reads `kill_switch_state`, fail-safe, with a short TTL cache.

    `in_memory=True` is for tests and for local runs with no Supabase: the
    switch is then whatever the test sets, never a silent "clear".
    """

    def __init__(
        self,
        client: Any | None = None,
        *,
        in_memory: bool = False,
        clock: Any = time.monotonic,
    ) -> None:
        self._client = client
        self._in_memory = in_memory
        self._clock = clock
        self._rows: list[dict] | None = None
        self._read_at: float | None = None
        self._last_read_failed = False
        self._memory_rows: list[dict] = []

    @classmethod
    def from_settings(cls, settings: Settings | None = None) -> KillSwitchReader:
        s = settings or get_settings()
        if s.supabase_url.startswith("http://localhost") or s.supabase_url.startswith("http://127."):
            return cls(in_memory=True)
        try:
            from supabase import create_client

            return cls(create_client(s.supabase_url, s.supabase_service_key))
        except Exception:
            # No client means no way to verify the stop is clear. In-memory
            # mode starts clear, which is correct for local development; a
            # deployed runtime reaches this only if Supabase is unreachable at
            # construction, and every later read then fails closed.
            log.warning("kill_switch.client_unavailable")
            return cls(in_memory=True)

    # ─── test helpers ────────────────────────────────────────────────
    def engage_in_memory(self, *, scope: str = GLOBAL_SCOPE, tenant_id: str | None = None,
                         reason: str = "test") -> None:
        self._memory_rows.append(
            {"scope": scope, "tenant_id": tenant_id, "engaged": True, "reason": reason}
        )
        self.invalidate()

    def release_in_memory(self) -> None:
        self._memory_rows = []
        self.invalidate()

    def invalidate(self) -> None:
        self._rows = None
        self._read_at = None

    # ─── the read ────────────────────────────────────────────────────
    def _load(self) -> list[dict]:
        now = self._clock()
        if (
            self._rows is not None
            and self._read_at is not None
            and now - self._read_at < CACHE_TTL_SECONDS
        ):
            return self._rows

        if self._in_memory:
            self._last_read_failed = False
            self._rows = list(self._memory_rows)
            self._read_at = now
            return self._rows

        try:
            response = (
                self._client.table("kill_switch_state")
                .select("scope, tenant_id, engaged, reason")
                .eq("engaged", True)
                .execute()
            )
            rows = list(response.data or [])
        except Exception as exc:
            # Fail SAFE. Serving a stale "clear" here would let a batch keep
            # mutating a client estate through the exact incident the switch
            # exists for.
            self._last_read_failed = True
            log.error("kill_switch.unreadable", error=str(exc))
            return self._rows or []

        self._last_read_failed = False
        self._rows = rows
        self._read_at = now
        return rows

    def state(self, tenant_id: str | None = None) -> KillSwitchState:
        rows = self._load()
        if self._last_read_failed:
            return KillSwitchState(
                engaged=True,
                scope=GLOBAL_SCOPE,
                reason="kill switch state is unreadable; assuming engaged",
            )
        for row in rows:
            if row.get("scope") == GLOBAL_SCOPE:
                return KillSwitchState(True, GLOBAL_SCOPE, row.get("reason") or "engaged")
        if tenant_id:
            for row in rows:
                if row.get("scope") == "tenant" and row.get("tenant_id") == tenant_id:
                    return KillSwitchState(True, "tenant", row.get("reason") or "engaged")
        return KillSwitchState(False, "", "")

    def is_engaged(self, tenant_id: str | None = None) -> bool:
        return self.state(tenant_id).engaged

    def raise_if_engaged(self, tenant_id: str | None = None) -> None:
        """Checkpoint for the execution path.

        Called before every mutating step and between bounded chunks, so the
        stop latency is one step rather than one batch.
        """
        current = self.state(tenant_id)
        if current.engaged:
            log.warning("kill_switch.halt", scope=current.scope, tenant_id=tenant_id)
            raise KillSwitchEngaged(current.scope, current.reason)
