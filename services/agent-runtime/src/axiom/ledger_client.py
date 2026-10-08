"""Append-only audit ledger client (Python).

Mirrors packages/ledger/src/append.ts. Used by every agent to write
to the hash-chained audit ledger. Writes go through the Postgres
SECURITY DEFINER function `append_agent_ledger()` (a wrapper over the internal
`append_ledger()`), authenticated as the scoped `agent_ledger_writer` role.
That function refuses human actor types, and the generic service-role key can
no longer execute `append_ledger()`, so this client never uses it.

This module never bypasses the function — the only INSERT path is
via the RPC, which is enforced at the DB role level too.
"""

from __future__ import annotations

import asyncio
import base64
import json
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, TypedDict, cast
from urllib.parse import urlsplit

from supabase import Client, create_client
from supabase.lib.client_options import SyncClientOptions

from .canonicalise import canonical_json, sha256_hex
from .config import Settings, get_settings

ActorType = Literal["agent", "human", "system"]
LedgerResult = Literal["success", "failure", "rolled_back", "skipped", "pending"]


class MemoryChain(TypedDict):
    last_seq: int
    last_hash: str | None


@dataclass(frozen=True)
class AppendInput:
    tenant_id: str
    correlation_id: str
    actor_type: ActorType
    actor_id: str
    action_type: str
    result: LedgerResult = "pending"
    agent_version: str | None = None
    model_id: str | None = None
    prompt_hash: str | None = None
    target_ref: str | None = None
    input_hash: str | None = None
    output_hash: str | None = None
    approval_token_id: str | None = None
    approver_id: str | None = None
    pre_state_ref: str | None = None
    post_state_ref: str | None = None
    detail: dict[str, Any] | None = None


@dataclass(frozen=True)
class AppendResult:
    id: str
    occurred_at: datetime


def _validated_writer_key(key: str | None, service_key: str | None) -> str:
    """Fail closed unless `key` is an unexpired agent_ledger_writer JWT.

    PostgREST authenticates the signature; this only catches misconfiguration
    (absent key, the shared service key, a different role, an expired token).
    """
    if not key or key == service_key:
        raise ValueError("unavailable")
    parts = key.split(".")
    if len(parts) != 3:
        raise ValueError("malformed")
    claims = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
    exp = claims.get("exp") if isinstance(claims, dict) else None
    if (
        not isinstance(claims, dict)
        or claims.get("role") != "agent_ledger_writer"
        or isinstance(exp, bool)
        or not isinstance(exp, (int, float))
        or exp <= time.time()
    ):
        raise ValueError("invalid")
    return key


class LedgerClient:
    """Append-only audit ledger client.

    The constructor accepts either a Supabase client (production) or
    `in_memory=True` (tests). The memory implementation supplies test receipts
    and a local chain; it is not evidence of PostgreSQL durability or identical
    SQL canonicalization. Strict environments always use the real RPC.
    """

    def __init__(
        self,
        client: Client | None = None,
        *,
        read_client: Client | None = None,
        in_memory: bool = False,
    ):
        # `client` carries the append-only agent-writer credential and can only
        # execute append_agent_ledger. Verification and queries are reads that
        # the writer deliberately cannot perform, so they use `read_client`.
        self._client = client
        self._read_client = read_client
        self._in_memory = in_memory
        self._mem: list[dict[str, object]] = []
        self._mem_chains: dict[str, MemoryChain] = {}

    @classmethod
    def from_settings(cls, settings: Settings | None = None) -> LedgerClient:
        s = settings or get_settings()
        try:
            target = urlsplit(s.supabase_url)
            is_loopback = target.scheme == "http" and target.hostname in {
                "localhost",
                "127.0.0.1",
                "::1",
            }
        except ValueError:
            raise RuntimeError("Audit ledger configuration was refused") from None
        if (
            s.environment in {"development", "test"}
            and is_loopback
            and getattr(s, "supabase_agent_ledger_writer_key", None) is None
        ):
            # Legacy local development/test without a writer remains in memory.
            # A configured writer must use the real RPC, even on loopback, and
            # empty or invalid credentials must fail closed below.
            return cls(in_memory=True)
        try:
            # Scoped writer identity: public gateway apikey + writer Bearer.
            # Absent/generic/cross-role/expired credentials are refused here,
            # never downgraded to the service-role key.
            writer_key = _validated_writer_key(
                getattr(s, "supabase_agent_ledger_writer_key", None),
                getattr(s, "supabase_service_key", None),
            )
            anon_key = getattr(s, "supabase_anon_key", None)
            if not anon_key:
                raise ValueError("unavailable")
            client = create_client(
                s.supabase_url,
                anon_key,
                options=SyncClientOptions(headers={"Authorization": f"Bearer {writer_key}"}),
            )
            # Reads (verify_ledger, audit_ledger queries) use the service key the
            # runtime already holds; it is never used to append.
            service_key = getattr(s, "supabase_service_key", None)
            if not service_key:
                raise ValueError("unavailable")
            read_client = create_client(s.supabase_url, service_key)
            return cls(client, read_client=read_client)
        except Exception:
            raise RuntimeError("Audit ledger configuration was refused") from None

    @classmethod
    def in_memory(cls) -> LedgerClient:
        return cls(in_memory=True)

    def append_only_view(self) -> LedgerClient:
        """Clone only the scoped audit writer, never the privileged read client.

        This narrows an agent capability within the process; it does not claim
        process isolation. The database still enforces the writer role grants.
        """
        view = AppendOnlyLedgerClient(self._client, in_memory=self._in_memory)
        view._mem = self._mem
        view._mem_chains = self._mem_chains
        return view

    @property
    def in_memory_mode(self) -> bool:
        return self._in_memory

    async def load_public_source_dispatch(
        self, *, tenant_id: str, run_id: str, agent: str, correlation_id: str
    ) -> Any:
        """Read only the stored source for a currently authorized, recorded run.

        The scoped writer may execute this restricted SQL loader. Public work
        never falls back to fabricated or in-memory source facts.
        """
        if self._in_memory or self._client is None:
            raise RuntimeError("Public source dispatch configuration was refused")
        client = self._client

        def read() -> Any:
            return (
                client.rpc(
                    "get_public_source_dispatch_input",
                    {
                        "p_tenant_id": tenant_id,
                        "p_run_id": run_id,
                        "p_agent": agent,
                        "p_correlation_id": correlation_id,
                    },
                )
                .execute()
                .data
            )

        return await asyncio.to_thread(read)

    async def claim_public_source_dispatch(
        self,
        *,
        tenant_id: str,
        run_id: str,
        agent: str,
        correlation_id: str,
        dispatch_id: str,
        request_hash: str,
    ) -> Any:
        """Atomically permit one execution; an ambiguous attempt cannot be reclaimed."""
        if self._in_memory or self._client is None:
            raise RuntimeError("Public source dispatch configuration was refused")
        client = self._client

        def claim() -> Any:
            return (
                client.rpc(
                    "claim_public_source_dispatch",
                    {
                        "p_tenant_id": tenant_id,
                        "p_run_id": run_id,
                        "p_agent": agent,
                        "p_correlation_id": correlation_id,
                        "p_dispatch_id": dispatch_id,
                        "p_request_hash": request_hash,
                    },
                )
                .execute()
                .data
            )

        return await asyncio.to_thread(claim)

    @property
    def memory_entries(self) -> list[dict[str, object]]:
        """In-memory ledger entries (test-only)."""
        return list(self._mem)

    async def load_reviewed_workflow_dispatch(
        self, *, tenant_id: str, run_id: str, operation_key: str
    ) -> Any:
        """Restricted transport source; memory cannot establish human provenance."""
        if self._in_memory or self._client is None:
            raise RuntimeError("Reviewed source transport configuration was refused")
        client = self._client

        def read() -> Any:
            return (
                client.rpc(
                    "read_reviewed_workflow_dispatch",
                    {
                        "p_tenant_id": tenant_id,
                        "p_run_id": run_id,
                        "p_operation_key": operation_key,
                    },
                )
                .execute()
                .data
            )

        return await asyncio.to_thread(read)

    async def claim_reviewed_workflow_dispatch(
        self, *, tenant_id: str, run_id: str, operation_key: str, request_hash: str
    ) -> Any:
        """Claim once; loss of this response never grants a retry."""
        if self._in_memory or self._client is None:
            raise RuntimeError("Reviewed source transport configuration was refused")
        client = self._client

        def claim() -> Any:
            return (
                client.rpc(
                    "claim_reviewed_workflow_dispatch",
                    {
                        "p_tenant_id": tenant_id,
                        "p_run_id": run_id,
                        "p_operation_key": operation_key,
                        "p_request_hash": request_hash,
                    },
                )
                .execute()
                .data
            )

        return await asyncio.to_thread(claim)

    async def append(self, input: AppendInput) -> AppendResult:
        # This client holds only the agent ledger identity. A human-labelled
        # event must be written by the BFF's human writer, so refuse it here
        # rather than let the database be the first line of defence.
        if input.actor_type not in ("agent", "system"):
            raise RuntimeError("Audit ledger append refused for actor type")
        if self._in_memory:
            return self._append_in_memory(input)
        return await self._append_remote(input)

    def _append_in_memory(self, input: AppendInput) -> AppendResult:
        from datetime import datetime as _dt

        from .canonicalise import canonical_json as _cj

        detail = input.detail or {}
        input_hash = input.input_hash or sha256_hex(_cj({**detail, "_kind": "input"}))
        output_hash = input.output_hash or sha256_hex(_cj({**detail, "_kind": "output"}))

        chain = self._mem_chains.setdefault(input.tenant_id, {"last_seq": 0, "last_hash": None})
        seq = int(chain["last_seq"]) + 1
        prev_hash = chain["last_hash"]
        ts = _dt.now(UTC).isoformat()
        payload = "|".join(
            [
                str(seq),
                input.correlation_id,
                input.actor_type,
                input.actor_id,
                str(input.agent_version or ""),
                str(input.model_id or ""),
                str(input.prompt_hash or ""),
                input.action_type,
                str(input.target_ref or ""),
                str(input.input_hash or input_hash),
                str(input.output_hash or output_hash),
                str(input.approval_token_id or ""),
                str(input.approver_id or ""),
                str(input.pre_state_ref or ""),
                str(input.post_state_ref or ""),
                input.result,
                ts,
                str(prev_hash or ""),
                str(detail),
            ]
        )
        entry_hash = sha256_hex(payload)
        entry = {
            "tenant_id": input.tenant_id,
            "sequence_no": seq,
            "correlation_id": input.correlation_id,
            "actor_type": input.actor_type,
            "actor_id": input.actor_id,
            "agent_version": input.agent_version,
            "model_id": input.model_id,
            "prompt_hash": input.prompt_hash,
            "action_type": input.action_type,
            "target_ref": input.target_ref,
            "input_hash": input_hash,
            "output_hash": output_hash,
            "approval_token_id": input.approval_token_id,
            "approver_id": input.approver_id,
            "pre_state_ref": input.pre_state_ref,
            "post_state_ref": input.post_state_ref,
            "result": input.result,
            "detail": detail,
            "occurred_at": ts,
            "prev_entry_hash": prev_hash,
            "entry_hash": entry_hash,
        }
        self._mem.append(entry)
        chain["last_seq"] = seq
        chain["last_hash"] = entry_hash
        return AppendResult(id=f"mem-{len(self._mem)}", occurred_at=_dt.fromisoformat(ts))

    async def _append_remote(self, input: AppendInput) -> AppendResult:
        detail = input.detail or {}

        # Compute input/output hashes from the canonical detail (if not provided)
        input_hash = input.input_hash or sha256_hex(canonical_json({**detail, "_kind": "input"}))
        output_hash = input.output_hash or sha256_hex(canonical_json({**detail, "_kind": "output"}))

        rpc = self._client.rpc(  # type: ignore[union-attr]
            "append_agent_ledger",
            {
                "p_tenant_id": input.tenant_id,
                "p_correlation_id": input.correlation_id,
                "p_actor_type": input.actor_type,
                "p_actor_id": input.actor_id,
                "p_agent_version": input.agent_version,
                "p_model_id": input.model_id,
                "p_prompt_hash": input.prompt_hash,
                "p_action_type": input.action_type,
                "p_target_ref": input.target_ref,
                "p_input_hash": input_hash,
                "p_output_hash": output_hash,
                "p_approval_token_id": input.approval_token_id,
                "p_approver_id": input.approver_id,
                "p_pre_state_ref": input.pre_state_ref,
                "p_post_state_ref": input.post_state_ref,
                "p_result": input.result,
                "p_detail": detail,
            },
        )
        result = rpc.execute()
        # append_agent_ledger returns the global bigint row ID, not a UUID. Accept
        # the JSON integer or canonical decimal form, never an absent/zero ID.
        receipt = result.data
        if type(receipt) is int:
            valid = 0 < receipt <= 9223372036854775807
        elif isinstance(receipt, str):
            valid = (
                receipt.isascii()
                and receipt.isdigit()
                and 1 <= len(receipt) <= 19
                and not receipt.startswith("0")
                and int(receipt) <= 9223372036854775807
            )
        else:
            valid = False
        if not valid:
            raise RuntimeError("Audit ledger append was not confirmed")
        return AppendResult(id=str(receipt), occurred_at=datetime.now(UTC))

    @property
    def _reader(self) -> Client:
        client = self._read_client or self._client
        if client is None:
            raise RuntimeError("Audit read capability is unavailable")
        return client

    async def verify(self, tenant_id: str, from_sequence: int = 1) -> dict[str, Any]:
        rpc = self._reader.rpc(
            "verify_ledger",
            {"p_tenant_id": tenant_id, "p_from_sequence": from_sequence},
        )
        result = rpc.execute()
        rows = result.data
        if not isinstance(rows, list):
            raise RuntimeError("Audit verification response was refused")
        if not rows:
            return {"intact": True}
        first = rows[0]
        if (
            not isinstance(first, dict)
            or type(first.get("sequence_no")) is not int
            or not isinstance(first.get("reason"), str)
        ):
            raise RuntimeError("Audit verification response was refused")
        return {
            "intact": False,
            "firstBreak": {
                "sequenceNo": first["sequence_no"],
                "reason": first["reason"],
            },
        }

    async def query(
        self,
        *,
        tenant_id: str,
        from_sequence: int | None = None,
        to_sequence: int | None = None,
        from_time: str | None = None,
        to_time: str | None = None,
        actor_type: ActorType | None = None,
        actor_id: str | None = None,
        action_type: str | None = None,
        correlation_id: str | None = None,
        result: LedgerResult | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, object]]:
        q = (
            self._reader.table("audit_ledger")
            .select("*")
            .eq("tenant_id", tenant_id)
            .order("sequence_no", desc=True)
        )
        if from_sequence is not None:
            q = q.gte("sequence_no", from_sequence)
        if to_sequence is not None:
            q = q.lte("sequence_no", to_sequence)
        if from_time:
            q = q.gte("occurred_at", from_time)
        if to_time:
            q = q.lte("occurred_at", to_time)
        if actor_type:
            q = q.eq("actor_type", actor_type)
        if actor_id:
            q = q.eq("actor_id", actor_id)
        if action_type:
            q = q.eq("action_type", action_type)
        if correlation_id:
            q = q.eq("correlation_id", correlation_id)
        if result:
            q = q.eq("result", result)
        q = q.limit(limit)
        if offset:
            q = q.range(offset, offset + limit - 1)
        r = q.execute()
        rows = r.data
        if not isinstance(rows, list) or any(
            not isinstance(row, dict)
            or ("sequence_no" in row and type(row["sequence_no"]) is not int)
            for row in rows
        ):
            raise RuntimeError("Audit query response was refused")
        return cast(list[dict[str, object]], rows)


def new_correlation_id() -> str:
    return str(uuid.uuid4())


class AppendOnlyLedgerClient(LedgerClient):
    """Audit append capability with no retained reader or domain access."""

    @property
    def _reader(self) -> Client:
        raise PermissionError("Audit read capability is unavailable")

    async def load_public_source_dispatch(self, **kwargs: Any) -> dict[str, Any]:
        raise PermissionError("Source read capability is unavailable")

    async def claim_public_source_dispatch(self, **kwargs: Any) -> dict[str, Any]:
        raise PermissionError("Source claim capability is unavailable")

    async def load_reviewed_workflow_dispatch(self, **kwargs: Any) -> Any:
        raise PermissionError("Reviewed source read capability is unavailable")

    async def claim_reviewed_workflow_dispatch(self, **kwargs: Any) -> Any:
        raise PermissionError("Reviewed source claim capability is unavailable")
