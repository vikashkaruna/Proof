"""Unmounted source-bound lifecycle for a credential-free deterministic target.

All claim/source/phase RPC capabilities remain in the controller. Dedicated126
admission and session/workload verification must be supplied by its private port.
"""

from axiom_model_accounting import AccountingBinding, Receipt

from .accounted_controller import AccountedDispatchRequest, ClaimedAccountedTarget
from .canonicalise import canonical_json, sha256_hex
from .prativedan_assessment_draft_codec import (
    AssessmentDraftBinding,
    parse_claim_v2,
    parse_readback_v2,
    parse_source_v2,
    project_source_v2,
)
from .prativedan_assessment_store import AssessmentRpcPort, PrativedanAssessmentStore
from .prativedan_pure_renderer import PurePrativedanTarget


class PrativedanAccountedLifecycle:
    def __init__(
        self,
        store: PrativedanAssessmentStore,
        phase_port: AssessmentRpcPort,
        binding: AssessmentDraftBinding,
    ) -> None:
        self._store = store
        self._phase = phase_port
        self._source = AssessmentDraftBinding.model_validate(binding.model_dump())
        self._started: Receipt | None = None

    async def claim(self, request: AccountedDispatchRequest) -> ClaimedAccountedTarget:
        b = self._source
        if self._started is not None or (
            request.tenant_id,
            request.run_id,
            request.request_sha256,
        ) != (b.tenant_id, b.run_id, sha256_hex(b.request_text)):
            raise ValueError("dedicated_accounting_dispatch_refused")
        stored = parse_readback_v2(await self._store.load(b), b)
        if stored.state != "requested":
            raise ValueError("dedicated_accounting_already_claimed")
        normalized = project_source_v2(parse_source_v2(stored.source_text, stored.source_sha256))
        input_text = canonical_json(normalized.model_dump(mode="json"))
        claim = parse_claim_v2(await self._store.claim(b, input_text), b)
        if claim.claimed is not True:
            raise ValueError("dedicated_accounting_claim_uncertain")
        # Claim and original input text are now frozen; the target receives data only.
        started = Receipt.model_validate(
            await self._phase.call(
                "record_prativedan_assessment_phase",
                {**self._store.arguments(b), "phase_name": "started", "output_hash": None},
            )
        )
        self._started = started
        binding = AccountingBinding(
            schema_version=2,
            tenant_id=b.tenant_id,
            run_id=b.run_id,
            correlation_id=b.operation_key,
            request_sha256=sha256_hex(b.request_text),
            agent="prativedan",
            agent_version="0.1.0",
        )
        return ClaimedAccountedTarget(binding, PurePrativedanTarget(input_text), started)

    async def complete(
        self,
        binding: AccountingBinding,
        started: Receipt,
        output_sha256: str | None,
        failure_code: str | None,
    ) -> Receipt:
        b = self._source
        expected = AccountingBinding(
            schema_version=2,
            tenant_id=b.tenant_id,
            run_id=b.run_id,
            correlation_id=b.operation_key,
            request_sha256=sha256_hex(b.request_text),
            agent="prativedan",
            agent_version="0.1.0",
        )
        if (
            binding != expected
            or self._started != started
            or output_sha256 is None
            or failure_code is not None
        ):
            # 126 has no sanctioned failure phase: preserve uncertainty, invent nothing.
            raise ValueError("dedicated_accounting_completion_uncertain")
        return Receipt.model_validate(
            await self._phase.call(
                "record_prativedan_assessment_phase",
                {
                    **self._store.arguments(b),
                    "phase_name": "completed",
                    "output_hash": output_sha256,
                },
            )
        )
