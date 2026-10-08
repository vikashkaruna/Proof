"""Authenticated BFF source composition, not an independent/legal attestation.

This capability permits only read-only planning and audit telemetry. It contains
no database/action writer credential, approval token or execution grant.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from .agents.base import DispatchContext
from .agents.sudhaar import SudhaarInput
from .canonicalise import canonical_json, sha256_hex


class SignedPlanningRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    signed_text: str = Field(min_length=1, max_length=600_000)
    signature: str = Field(pattern=r"^[a-f0-9]{64}$")


class PlanningPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: Literal[1]
    input_text: str = Field(min_length=1, max_length=524_288)
    correlation_id: str
    dispatch_context: DispatchContext
    expires_at: int


def verify_planning_request(
    request: SignedPlanningRequest,
    secret: str | None,
    now: float | None = None,
    *,
    peer_secret: str | None = None,
) -> tuple[SudhaarInput, str, DispatchContext]:
    if (
        not secret
        or len(secret.encode()) < 32
        or secret == peer_secret
        or len(request.signed_text.encode()) > 600_000
    ):
        raise ValueError("Planning signature refused")
    expected = hmac.new(
        secret.encode(), b"axiom-sudhaar-source-v1\0" + request.signed_text.encode(), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, request.signature):
        raise ValueError("Planning signature refused")
    raw = json.loads(request.signed_text)
    if canonical_json(raw) != request.signed_text:
        raise ValueError("Planning capability serialization refused")
    payload = PlanningPayload.model_validate(raw)
    delta = payload.expires_at - (time.time() if now is None else now)
    if not 0 < delta <= 120 or len(payload.input_text.encode()) > 524_288:
        raise ValueError("Planning capability expired")
    correlation = str(UUID(payload.correlation_id))
    if (
        correlation != payload.correlation_id
        or sha256_hex(payload.input_text) != payload.dispatch_context.request_hash
    ):
        raise ValueError("Planning dispatch refused")
    value = SudhaarInput.model_validate(json.loads(payload.input_text))
    if canonical_json(value.model_dump(mode="json")) != payload.input_text:
        raise ValueError("Planning input serialization refused")
    return value, correlation, payload.dispatch_context
