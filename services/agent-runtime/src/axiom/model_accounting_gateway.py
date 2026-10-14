"""Controller-owned SDK adapter; no target credentials or vendor invoice claims."""

from __future__ import annotations

import asyncio
import json
import math
from decimal import Decimal, localcontext
from typing import Protocol

from axiom_model_accounting import CallCompletion, CallOutcome, CallPayload, CallStart, _packet

from .canonicalise import sha256_hex
from .model_gateway import ModelRequest, ModelResponse


class CompletionSdk(Protocol):
    async def complete(self, request: ModelRequest) -> ModelResponse: ...


class AccountingSdkGateway:
    """Injected SDK stays in controller custody, outside the pure target."""

    def __init__(self, sdk: CompletionSdk, *, deadline_seconds: float = 60.0) -> None:
        if (
            isinstance(deadline_seconds, bool)
            or not math.isfinite(deadline_seconds)
            or not 0 < deadline_seconds <= 60
        ):
            raise ValueError("accounting_gateway_deadline_invalid")
        self._sdk = sdk
        self._deadline_seconds = deadline_seconds

    async def complete(self, request_text: str, start: CallStart) -> CallCompletion:
        try:
            original = _packet(request_text, 1048576)
            if not isinstance(original, dict):
                raise ValueError("invalid packet")
            raw = dict(original)
            prompt_hash = raw.pop("prompt_hash", None)
            payload = CallPayload.model_validate(raw)
            canonical = json.dumps(
                original, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
            )
            if (
                canonical != request_text
                or not payload.pii_redact
                or prompt_hash != sha256_hex(payload.prompt)
                or start.request_json_sha256 != sha256_hex(request_text)
                or start.template_sha256 != prompt_hash
                or start.model_selector != payload.model
                or start.task != payload.task
            ):
                raise ValueError("invalid original commitment")
        except (ValueError, TypeError, OverflowError) as error:
            raise ValueError("accounting_gateway_request_invalid") from error

        request = ModelRequest(
            model=payload.model,
            prompt=payload.prompt,
            task=payload.task,
            temperature=payload.temperature,
            max_tokens=payload.max_tokens,
            variables=payload.variables,
            pii_redact=payload.pii_redact,
            response_format=payload.response_format,
        )
        task = asyncio.create_task(self._sdk.complete(request))
        try:
            done, _pending = await asyncio.wait({task}, timeout=self._deadline_seconds)
            if not done:
                raise TimeoutError("accounting_gateway_deadline_exceeded")
            response = task.result()
        finally:
            if not task.done():
                # Do not wait for a cancellation-suppressing SDK. Any late result
                # is discarded; this does not assert that vendor work stopped.
                task.cancel()
            task.add_done_callback(_discard_late_result)
        try:
            # Revalidate even unchecked model_copy results from an injected port.
            response = ModelResponse.model_validate(response.model_dump())
            p = response.provenance
            c = p.commitments
            if (
                not response.pii_redacted
                or c.request_json_sha256 != start.request_json_sha256
                or c.request_json_basis != start.request_json_basis
                or c.template_sha256 != start.template_sha256
                or c.caller_prompt_sha256 != start.template_sha256
            ):
                raise ValueError("invalid response commitment")
            estimate = None
            if p.pricing.basis == "configuration_estimate":
                u, price = p.usage, p.pricing
                if (
                    u.input_tokens is None
                    or u.output_tokens is None
                    or price.input_rate is None
                    or price.output_rate is None
                ):
                    raise ValueError("invalid estimate inputs")
                # Float response cost is never promoted to an exact amount.
                with localcontext() as context:
                    context.prec = 340
                    exact = (
                        Decimal(str(price.input_rate)) * u.input_tokens
                        + Decimal(str(price.output_rate)) * u.output_tokens
                    )
                estimate = format(exact, "f")
                if "." in estimate:
                    estimate = estimate.rstrip("0").rstrip(".")
            outcome = CallOutcome.model_validate(
                {
                    **start.model_dump(),
                    "state": "completed",
                    "failure_code": None,
                    "content_sha256": sha256_hex(response.text),
                    "planned": p.planned.model_dump(),
                    "serving": p.serving.model_dump(),
                    "commitments": {
                        "composed_sha256": c.composed_sha256,
                        "transport_prompt_sha256": c.transport_prompt_sha256,
                        "sdk_handoff_sha256": c.sdk_handoff_sha256,
                        "basis": c.basis,
                    },
                    "attempts": [a.model_dump() for a in p.attempts],
                    "usage": p.usage.model_dump(exclude={"reason"}),
                    "pricing": {
                        "basis": p.pricing.basis,
                        "scope": p.pricing.scope,
                        "config_sha256": p.pricing.config_sha256,
                        "estimate_usd": estimate,
                    },
                }
            )
            return CallCompletion(text=response.text, observation=outcome)
        except (ValueError, TypeError, AttributeError, OverflowError) as error:
            raise ValueError("accounting_gateway_response_invalid") from error


def _discard_late_result(task: asyncio.Task[ModelResponse]) -> None:
    if not task.cancelled():
        task.exception()
