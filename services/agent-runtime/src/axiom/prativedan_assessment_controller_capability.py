"""Credential-free, unmounted private-controller phase capability.

The required port must be the server-owned authenticated private channel. This
class has no database client/key and does not verify an SVID or provision that
channel. SQL derives phase metadata; settlement separately validates real bytes.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime

from .canonicalise import sha256_hex
from .ledger_client import AppendInput, AppendOnlyLedgerClient, AppendResult
from .prativedan_assessment_draft_codec import AssessmentDraftBinding, AssessmentReceipt
from .prativedan_assessment_store import AssessmentRpcPort, PrativedanAssessmentStore
from .prativedan_renderer_config import renderer_commitment


class PrativedanControllerLedger(AppendOnlyLedgerClient):
    def __init__(
        self, port: AssessmentRpcPort, binding: AssessmentDraftBinding, input_sha256: str
    ) -> None:
        if not re.fullmatch(r"[a-f0-9]{64}", input_sha256):
            raise ValueError("Normalized input commitment refused")
        super().__init__()
        self._port = port
        self._binding = binding
        self.input_sha256 = input_sha256
        self._started: str | None = None

    def append_only_view(self) -> PrativedanControllerLedger:
        return self

    async def append(self, input: AppendInput) -> AppendResult:
        binding = self._binding
        version, _text, digest = renderer_commitment()
        detail = input.detail or {}
        phase = detail.get("phase")
        expected = {
            "phase": phase,
            "run_id": binding.run_id,
            "request_hash": sha256_hex(binding.request_text),
            "renderer_config_version": version,
            "renderer_config_sha256": digest,
        }
        if phase == "completed":
            expected["started_entry"] = self._started
        if (
            phase not in ("started", "completed")
            or detail != expected
            or input.tenant_id != binding.tenant_id
            or input.correlation_id != binding.operation_key
            or input.actor_type != "agent"
            or input.actor_id != "prativedan"
            or input.agent_version != "0.1.0"
            or input.action_type != "report.generated"
            or input.target_ref != binding.engagement_id
            or input.model_id is not None
            or input.prompt_hash is not None
            or input.approval_token_id is not None
            or input.approver_id is not None
            or input.pre_state_ref is not None
            or input.post_state_ref is not None
            or input.input_hash != self.input_sha256
            or (phase == "started" and (input.result != "pending" or input.output_hash is not None))
            or (
                phase == "completed"
                and (
                    self._started is None
                    or input.result != "success"
                    or not isinstance(input.output_hash, str)
                    or not re.fullmatch(r"[a-f0-9]{64}", input.output_hash)
                )
            )
        ):
            raise PermissionError("Dedicated fixed phase capability refused")
        # No retries: a lost response leaves the phase outcome unknown.
        raw = await self._port.call(
            "record_prativedan_assessment_phase",
            {
                **PrativedanAssessmentStore.arguments(binding),
                "phase_name": phase,
                "output_hash": input.output_hash,
            },
        )
        receipt = AssessmentReceipt.model_validate(raw)
        if phase == "started":
            self._started = receipt.id
        return AppendResult(id=receipt.id, occurred_at=datetime.now(UTC))
