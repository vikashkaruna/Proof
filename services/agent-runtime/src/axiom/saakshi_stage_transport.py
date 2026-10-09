"""Fixed internal staging transport; carries metadata, never bytes or provider credentials."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import time
from urllib.parse import urlsplit

import httpx

from .agents.base import AgentRunResult, DispatchContext
from .agents.saakshi_stage_agent import SaakshiStageAgent
from .canonicalise import canonical_json, sha256_hex
from .ledger_client import LedgerClient
from .saakshi_dispatch import (
    EvidenceInvokeRequest,
    PreparedEvidenceDispatch,
    prepare_evidence_dispatch,
)
from .saakshi_staging import EvidenceStageInput, EvidenceStagePort, EvidenceStageReceipt


class InternalEvidenceStageTransport:
    def __init__(
        self,
        *,
        stage_url: str,
        peer_secret: str,
        source_secret: str,
        other_secrets: tuple[str | None, ...] = (),
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        url = urlsplit(stage_url)
        if (
            url.scheme not in {"https", "http"}
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
            or url.path != "/internal/staged-evidence/stage"
            or len(peer_secret.encode()) < 32
            or len(source_secret.encode()) < 32
            or peer_secret == source_secret
            or source_secret in other_secrets
            or peer_secret in other_secrets
        ):
            raise ValueError("Evidence staging configuration is unavailable")
        self._url = stage_url
        self._peer = peer_secret
        self._source = source_secret
        self._transport = transport

    def port(self, prepared: PreparedEvidenceDispatch) -> EvidenceStagePort:
        async def stage(source: EvidenceStageInput, correlation: str) -> EvidenceStageReceipt:
            try:
                if source != prepared.source or correlation != prepared.correlation_id:
                    raise ValueError("Evidence stage was refused")
                remaining = (prepared.expires_at_ms - time.time() * 1000) / 1000
                if remaining <= 0:
                    raise ValueError("Evidence stage was refused")
                input_text = canonical_json(source.model_dump(mode="json"))
                signed = canonical_json(
                    {
                        "version": 1,
                        "input_text": input_text,
                        "correlation_id": correlation,
                        "dispatch_context": {
                            "run_id": prepared.run_id,
                            "request_hash": sha256_hex(input_text),
                        },
                        "expires_at": int(time.time() + min(119, remaining)),
                    }
                )
                signature = hmac.new(
                    self._source.encode(),
                    b"axiom-saakshi-stage-v1\0" + signed.encode(),
                    hashlib.sha256,
                ).hexdigest()
                async with asyncio.timeout(min(30, remaining)):
                    async with httpx.AsyncClient(
                        transport=self._transport, follow_redirects=False
                    ) as client:
                        async with client.stream(
                            "POST",
                            self._url,
                            headers={"Authorization": "Bearer " + self._peer},
                            json={"signed_text": signed, "signature": signature},
                        ) as response:
                            if (
                                response.status_code != 200
                                or response.headers.get("content-encoding", "identity")
                                != "identity"
                            ):
                                raise ValueError("Evidence stage was refused")
                            length = response.headers.get("content-length")
                            if length is not None and (not length.isdigit() or int(length) > 32000):
                                raise ValueError("Evidence stage was refused")
                            chunks = []
                            size = 0
                            async for chunk in response.aiter_raw():
                                size += len(chunk)
                                if size > 32000:
                                    raise ValueError("Evidence stage was refused")
                                chunks.append(chunk)
                            return EvidenceStageReceipt.model_validate_json(b"".join(chunks))
            except Exception:
                raise ValueError("Evidence staging is unconfirmed") from None

        return EvidenceStagePort(prepared.source, prepared.correlation_id, stage)


async def invoke_staged_evidence(
    ledger: LedgerClient, request: EvidenceInvokeRequest, transport: InternalEvidenceStageTransport
) -> AgentRunResult:
    """Dedicated mount calls this; no generic request can supply input or stage URL."""
    prepared = await prepare_evidence_dispatch(ledger, request, now_ms=int(time.time() * 1000))
    agent = SaakshiStageAgent(ledger=ledger, port=transport.port(prepared))
    return await agent.invoke(
        prepared.source,
        correlation_id=prepared.correlation_id,
        dispatch_context=DispatchContext.model_validate(
            {
                "run_id": prepared.run_id,
                "request_hash": sha256_hex(canonical_json(prepared.source.model_dump(mode="json"))),
            }
        ),
    )
