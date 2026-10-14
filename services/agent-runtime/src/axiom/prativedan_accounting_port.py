"""Unmounted dedicated controller adapter; never given to a renderer target.

The verifier port MUST obtain current session/workload facts independently.
This adapter creates no database client and never manufactures authority context.
"""

from typing import Protocol

from axiom_model_accounting import AccountingBinding, AccountingStoreError

from .model_call_store import AccountingRpcPort


class CurrentPrativedanAccountingContext(Protocol):
    async def verified_context(self, binding: AccountingBinding) -> dict[str, object]: ...


class PrativedanAccountingPort:
    def __init__(
        self,
        rpc: AccountingRpcPort,
        context: CurrentPrativedanAccountingContext,
        binding: AccountingBinding,
    ) -> None:
        if binding.agent != "prativedan" or binding.agent_version != "0.1.0":
            raise AccountingStoreError("Dedicated accounting binding refused")
        self._rpc = rpc
        self._context = context
        self._binding = AccountingBinding.model_validate(binding.model_dump())

    async def call(self, name: str, arguments: dict[str, object]) -> object:
        fields = {
            "load_model_accounting_dispatch": set(),
            "begin_model_accounting_call": {"call_id", "start_text"},
            "finish_model_accounting_call": {"call_id", "outcome_text"},
            "seal_model_accounting_run": {"started", "completed"},
            "read_model_accounting_run": set(),
            "read_model_accounting_result": set(),
        }
        b = self._binding
        expected = {"t": b.tenant_id, "r": b.run_id, "rh": b.request_sha256}
        if (
            name not in fields
            or set(arguments) != set(expected) | fields.get(name, set())
            or any(arguments[k] != v for k, v in expected.items())
        ):
            raise AccountingStoreError("Dedicated accounting operation refused")
        authority = await self._context.verified_context(b)
        # New context for each request; never reuse caller assertions or cached grants.
        return await self._rpc.call(
            "prativedan_" + name, {**arguments, "k": b.correlation_id, "authority": authority}
        )
