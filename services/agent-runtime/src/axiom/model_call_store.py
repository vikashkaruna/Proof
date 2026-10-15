"""Unmounted controller-only scoped RPC port; never attach this to an agent.

The required RPC adapter is independently trusted controller custody. This
module creates no database client, writer credentials or permissive fallback.
RPCs in migration0128 must derive authority from the original durable run.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Literal, Protocol
from uuid import uuid4

from axiom_model_accounting import (
    AccountingBinding,
    AccountingSeal,
    AccountingStoreError,
    ExpectedResult,
    Receipt,
    _packet,
    verify_accounting_seal,
)

from .canonicalise import canonical_json, sha256_hex
from .model_call_accounting import (
    CallCompletion,
    CallOutcome,
    CallPayload,
    CallStart,
    Digest,
    Identifier,
    Pricing,
    Usage,
)


class AccountingLoaded(AccountingBinding):
    requested_receipt: Receipt
    claimed: bool


class CallClaim(AccountingBinding):
    call_id: Identifier
    claimed: bool
    start_sha256: Digest
    started_receipt: Receipt


class CallRecorded(AccountingBinding):
    call_id: Identifier
    outcome_sha256: Digest
    completed_receipt: Receipt


class AccountingRpcPort(Protocol):
    async def call(self, name: str, arguments: dict[str, object]) -> object: ...


class ModelCallStore:
    """Controller-exclusive journal capability; no retries or agent credential port."""

    def __init__(self, rpc: AccountingRpcPort) -> None:
        self._rpc = rpc

    @staticmethod
    def arguments(binding: AccountingBinding) -> dict[str, object]:
        expected = AccountingBinding.model_validate(binding.model_dump())
        return {"t": expected.tenant_id, "r": expected.run_id, "rh": expected.request_sha256}

    async def load(self, binding: AccountingBinding) -> AccountingLoaded:
        try:
            result = AccountingLoaded.model_validate(
                await self._rpc.call("load_model_accounting_dispatch", self.arguments(binding))
            )
            if (
                result.claimed is not True
                or AccountingBinding.model_validate(
                    result.model_dump(include=set(AccountingBinding.model_fields))
                )
                != binding
            ):
                raise AccountingStoreError("Accounting load refused")
            return result
        except Exception:
            raise AccountingStoreError("Accounting load unavailable") from None

    async def begin(
        self, binding: AccountingBinding, start: CallStart, start_text: str
    ) -> CallClaim:
        try:
            if (
                AccountingBinding.model_validate(
                    start.model_dump(include=set(AccountingBinding.model_fields))
                )
                != binding
                or CallStart.model_validate(_packet(start_text, 8192)) != start
            ):
                raise AccountingStoreError("Accounting start refused")
            result = CallClaim.model_validate(
                await self._rpc.call(
                    "begin_model_accounting_call",
                    {**self.arguments(binding), "call_id": start.call_id, "start_text": start_text},
                )
            )
            if (
                AccountingBinding.model_validate(
                    result.model_dump(include=set(AccountingBinding.model_fields))
                )
                != binding
                or result.call_id != start.call_id
                or result.start_sha256 != sha256_hex(start_text)
            ):
                raise AccountingStoreError("Accounting start refused")
            return result
        except Exception:
            # Even an immediate read cannot turn lost claim response into permission.
            raise AccountingStoreError("Accounting start uncertain") from None

    async def finish(
        self, binding: AccountingBinding, outcome: CallOutcome, outcome_text: str
    ) -> CallRecorded:
        try:
            if (
                AccountingBinding.model_validate(
                    outcome.model_dump(include=set(AccountingBinding.model_fields))
                )
                != binding
                or CallOutcome.model_validate(_packet(outcome_text, 16384)) != outcome
            ):
                raise AccountingStoreError("Accounting observation refused")
            result = CallRecorded.model_validate(
                await self._rpc.call(
                    "finish_model_accounting_call",
                    {
                        **self.arguments(binding),
                        "call_id": outcome.call_id,
                        "outcome_text": outcome_text,
                    },
                )
            )
            if (
                AccountingBinding.model_validate(
                    result.model_dump(include=set(AccountingBinding.model_fields))
                )
                != binding
                or result.call_id != outcome.call_id
                or result.outcome_sha256 != sha256_hex(outcome_text)
            ):
                raise AccountingStoreError("Accounting observation refused")
            return result
        except Exception:
            raise AccountingStoreError("Accounting observation uncertain") from None

    async def seal(
        self, binding: AccountingBinding, started: Receipt, completed: Receipt
    ) -> AccountingSeal:
        try:
            payload = await self._rpc.call(
                "seal_model_accounting_run",
                {**self.arguments(binding), "started": started.id, "completed": completed.id},
            )
            value = verify_accounting_seal(payload, binding)
            if value.agent_started_receipt != started or value.agent_completed_receipt != completed:
                raise AccountingStoreError("Accounting seal refused")
            return value
        except Exception:
            raise AccountingStoreError("Accounting seal uncertain") from None

    async def read(self, binding: AccountingBinding) -> AccountingSeal:
        try:
            return verify_accounting_seal(
                await self._rpc.call("read_model_accounting_run", self.arguments(binding)), binding
            )
        except Exception:
            raise AccountingStoreError("Accounting read unavailable") from None

    async def read_result(self, binding: AccountingBinding) -> ExpectedResult:
        """Independent terminal/journal read, never a caller-supplied seal."""
        try:
            value = ExpectedResult.model_validate(
                await self._rpc.call("read_model_accounting_result", self.arguments(binding))
            )
            if value.binding != binding:
                raise AccountingStoreError("Accounting result binding refused")
            verify_accounting_seal(value.seal.model_dump(), binding)
            return value
        except Exception:
            raise AccountingStoreError("Accounting result unavailable") from None


# Controller custody is intentionally outside the pure agent target. This is a
# same-process capability boundary, not a claim of operating-system isolation.
class CurrentAccountingAuthority(Protocol):
    async def require_current(self, binding: AccountingBinding) -> None: ...


class AccountingGatewayPort(Protocol):
    async def complete(self, request_text: str, start: CallStart) -> CallCompletion: ...


class PureAccountedTarget(Protocol):
    async def run(self, complete: Callable[[CallPayload], Awaitable[str]]) -> object: ...


@dataclass(frozen=True)
class AccountedComputation:
    output: object | None
    observations: tuple[CallOutcome, ...]
    failure_code: (
        Literal[
            "target_failed",
            "invocation_cancelled",
            "accounting_uncertain",
            "current_authority_refused",
        ]
        | None
    )
    # Even an empty successful computation is provisional. Receipt-driven seal
    # verification is required separately; this object cannot authorize release.
    accounting_proven: Literal[False] = False


@dataclass
class _Invocation:
    pending: set[asyncio.Task[object]] = field(default_factory=set)
    observations: dict[int, CallOutcome] = field(default_factory=dict)
    next_call: int = 0
    closed: bool = False
    uncertain: bool = False


class AccountedComposer:
    """Unmounted one-shot controller composition for a pure credential-free target.

    Caller must already own the sanctioned durable invocation claim. This class
    neither creates agent_runs nor repairs legacy agents holding writer clients.
    Shared/generic peer authentication is not invocation or accounting authority.
    """

    def __init__(
        self,
        store: ModelCallStore,
        gateway: AccountingGatewayPort,
        authority: CurrentAccountingAuthority,
    ) -> None:
        self._store = store
        self._gateway = gateway
        self._authority = authority

    async def compute(
        self, expected: AccountingBinding, target: PureAccountedTarget
    ) -> AccountedComputation:
        binding = AccountingBinding.model_validate(expected.model_dump())
        await self._authority.require_current(binding)
        await self._store.load(binding)
        await self._authority.require_current(binding)
        scope = _Invocation()

        async def complete(payload: CallPayload) -> str:
            if scope.closed or scope.next_call >= 1000:
                raise AccountingStoreError("Accounting scope closed")
            current = asyncio.current_task()
            if current is None:
                raise AccountingStoreError("Accounting scope unavailable")
            scope.pending.add(current)
            ordinal = scope.next_call
            scope.next_call += 1
            claimed = False
            provider_attempted = False
            start: CallStart | None = None
            try:
                value = CallPayload.model_validate(payload.model_dump())
                body = {**value.model_dump(), "prompt_hash": sha256_hex(value.prompt)}
                request_text = canonical_json(body)
                if len(request_text.encode("utf-8")) > 1048576:
                    raise AccountingStoreError("Accounting request bound refused")
                start = CallStart(
                    **binding.model_dump(),
                    call_id=str(uuid4()),
                    request_json_sha256=sha256_hex(request_text),
                    request_json_basis="canonical_decoded_request_not_http_wire",
                    template_sha256=sha256_hex(value.prompt),
                    model_selector=value.model,
                    task=value.task,
                )
                await self._authority.require_current(binding)
                claim = await self._store.begin(binding, start, canonical_json(start.model_dump()))
                if not claim.claimed:
                    scope.uncertain = True
                    raise AccountingStoreError("Accounting invocation uncertain")
                claimed = True
                await self._authority.require_current(binding)
                provider_attempted = True
                result = await self._gateway.complete(request_text, start)
                result = CallCompletion.model_validate(result.model_dump())
                actual_start = CallStart.model_validate(
                    result.observation.model_dump(include=set(CallStart.model_fields))
                )
                if (
                    actual_start != start
                    or result.observation.state != "completed"
                    or not result.text.strip()
                    or sha256_hex(result.text) != result.observation.content_sha256
                ):
                    raise ValueError("Accounting response refused")
                await self._store.finish(
                    binding, result.observation, canonical_json(result.observation.model_dump())
                )
                scope.observations[ordinal] = result.observation
                return result.text
            except asyncio.CancelledError:
                if claimed and start is not None:
                    await record_failure(start, ordinal, "cancelled", "invocation_cancelled")
                elif start is not None:
                    scope.uncertain = True
                raise
            except Exception as error:
                if claimed and start is not None:
                    # A finish error may already have persisted a successful
                    # observation: never issue an alternative second finish.
                    if isinstance(error, AccountingStoreError):
                        scope.uncertain = True
                    else:
                        await record_failure(
                            start,
                            ordinal,
                            "failed",
                            "current_authority_refused"
                            if not provider_attempted
                            else "gateway_response_invalid"
                            if isinstance(error, ValueError)
                            else "gateway_unavailable",
                        )
                elif start is not None:
                    scope.uncertain = True
                raise AccountingStoreError("Accounting call unavailable") from None
            finally:
                scope.pending.discard(current)

        async def record_failure(
            start: CallStart,
            ordinal: int,
            state: Literal["failed", "cancelled"],
            code: Literal[
                "gateway_response_invalid",
                "gateway_unavailable",
                "current_authority_refused",
                "invocation_cancelled",
            ],
        ) -> None:
            observation = CallOutcome(
                **start.model_dump(),
                state=state,
                failure_code=code,
                content_sha256=None,
                planned=None,
                serving=None,
                commitments=None,
                attempts=None,
                usage=Usage(
                    availability="unavailable",
                    input_tokens=None,
                    output_tokens=None,
                    total_tokens=None,
                ),
                pricing=Pricing(
                    basis="unavailable",
                    scope="successful_response_only",
                    config_sha256=None,
                    estimate_usd=None,
                ),
            )
            try:
                async with asyncio.timeout(2):
                    await self._store.finish(
                        binding, observation, canonical_json(observation.model_dump())
                    )
                scope.observations[ordinal] = observation
            except BaseException:
                # Cancellation/write loss does not assert that remote work stopped.
                scope.uncertain = True

        output: object | None = None
        failure: (
            Literal[
                "target_failed",
                "invocation_cancelled",
                "accounting_uncertain",
                "current_authority_refused",
            ]
            | None
        ) = None
        try:
            output = await target.run(complete)
        except asyncio.CancelledError:
            failure = "invocation_cancelled"
        except Exception:
            failure = "target_failed"
        finally:
            scope.closed = True
            pending = tuple(scope.pending)
            for task in pending:
                task.cancel()
            if pending:
                done, unfinished = await asyncio.wait(pending, timeout=3)
                for task in done:
                    if not task.cancelled():
                        task.exception()
                if unfinished:
                    scope.uncertain = True
        if scope.uncertain:
            failure = "accounting_uncertain"
            output = None
        try:
            await self._authority.require_current(binding)
        except Exception:
            # Observed completion remains committed for reconciliation; refusal
            # cannot authorize retry, erase facts, or expose business output.
            failure = "current_authority_refused"
            output = None
        return AccountedComputation(
            output, tuple(scope.observations[i] for i in sorted(scope.observations)), failure
        )
