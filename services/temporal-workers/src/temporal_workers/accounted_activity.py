"""Unmounted durable activity factory; independent scoped reader stays in closure.

Workflow/history receives identities and verified metadata only, never custody,
credentials, or a caller-provided expected seal. Transport has no retry fallback.
"""

from __future__ import annotations

from typing import Protocol

from axiom_model_accounting import (
    AccountingBinding,
    ExpectedResult,
    verify_accounted_result,
)
from temporalio import activity
from temporalio.exceptions import ApplicationError


class AccountedReadPort(Protocol):
    async def call(self, name: str, arguments: dict[str, object]) -> object: ...


class AccountedRuntimePort(Protocol):
    async def invoke(self, request: dict[str, str]) -> object: ...


def accounted_activity(*, runtime: AccountedRuntimePort, reader: AccountedReadPort):
    @activity.defn(name="call_accounted_agent_runtime")
    async def invoke(dispatch: dict[str, object]) -> dict[str, object]:
        failure = "accounted_invocation_unconfirmed"
        try:
            binding = AccountingBinding.model_validate(dispatch)
            wire = await runtime.invoke(
                {
                    "tenant_id": binding.tenant_id,
                    "run_id": binding.run_id,
                    "request_sha256": binding.request_sha256,
                }
            )
            witness = ExpectedResult.model_validate(
                await reader.call(
                    "read_model_accounting_result",
                    {
                        "t": binding.tenant_id,
                        "r": binding.run_id,
                        "rh": binding.request_sha256,
                    },
                )
            )
            if witness.binding != binding:
                raise ValueError("accounted_dispatch_refused")
            verified = verify_accounted_result(wire, witness)
            if verified.result.status != "succeeded":
                raise ValueError("accounted_runtime_failed")
            return {
                "result": verified.result.model_dump(mode="json"),
                "output": verified.output,
                "accounting_status": verified.accounting_status,
            }
        except Exception:  # noqa: BLE001 — sanitize private RPC/HTTP causes for history.
            failure = "accounted_invocation_unconfirmed"
        # Sanitized, non-retryable: a lost one-shot dispatch must be reconciled.
        raise ApplicationError(
            failure,
            type=failure,
            non_retryable=True,
        )

    return invoke
