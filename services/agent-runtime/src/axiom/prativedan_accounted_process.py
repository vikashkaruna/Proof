"""Fixed zero-inference controller computation; never a provider integration.

This process runs in a network-none container without credentials. Its controller
RPC stream is private STDIO. The pure renderer is a separate UID20006 process,
not this controller process; neither receives human credentials or an SVID.
"""

from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import Awaitable, Callable
from typing import Literal, Protocol

from axiom_model_accounting import AccountingBinding, CallCompletion, CallPayload, CallStart
from pydantic import BaseModel, ConfigDict

from .canonicalise import canonical_json
from .model_accounting_gateway import AccountingSdkGateway
from .model_call_store import AccountedComposer, AccountingRpcPort, ModelCallStore
from .model_gateway import ModelRequest, ModelResponse
from .prativedan_contracts import PrativedanInput
from .prativedan_renderer_config import renderer_commitment


class DisabledCompletionSdk:
    async def complete(self, request: ModelRequest) -> ModelResponse:
        raise ValueError("deterministic_renderer_model_inference_disabled")


class ZeroOnlyGateway:
    """Guard before the real SDK adapter, including hostile target callbacks."""

    def __init__(self, adapter: AccountingSdkGateway) -> None:
        self._adapter = adapter

    async def complete(self, request_text: str, start: CallStart) -> CallCompletion:
        # The frozen renderer configuration model_inference:false permits no
        # SDK handoff. Keep the adapter in controller custody for future reviewed
        # configurations; do not manufacture a model call for accounting tests.
        raise ValueError("deterministic_renderer_model_inference_disabled")


class RendererPort(Protocol):
    async def render(self, input_text: str) -> object: ...


class CurrentAuthority(Protocol):
    async def require_current(self, binding: AccountingBinding) -> None: ...


class IsolatedRendererTarget:
    __slots__ = ("_input", "_renderer")

    def __init__(self, input_text: str, renderer: RendererPort) -> None:
        PrativedanInput.model_validate_json(input_text)
        self._input = input_text
        self._renderer = renderer

    async def run(self, complete: Callable[[CallPayload], Awaitable[str]]) -> object:
        # No completion callback crosses the renderer process boundary.
        return await self._renderer.render(self._input)


async def compute_zero_only(
    binding: AccountingBinding,
    input_text: str,
    rpc: AccountingRpcPort,
    authority: CurrentAuthority,
    renderer: RendererPort,
) -> tuple[str | None, str | None]:
    _, config_text, _ = renderer_commitment()
    if json.loads(config_text)["model_inference"] is not False:
        raise ValueError("deterministic_renderer_config_refused")
    # Actual adapter composition, with a fixed disabled provider and the
    # controller-boundary zero-only guard. No provider URL/key/client exists.
    gateway = ZeroOnlyGateway(AccountingSdkGateway(DisabledCompletionSdk()))
    result = await AccountedComposer(ModelCallStore(rpc), gateway, authority).compute(
        binding, IsolatedRendererTarget(input_text, renderer)
    )
    return (
        canonical_json(result.output) if result.failure_code is None else None,
        result.failure_code,
    )


class ProcessInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    kind: Literal["compute_prativedan_zero"]
    binding: AccountingBinding
    input_text: str


class PrivateStdio:
    """One bounded frame at a time; never accepts caller-selected RPC names."""

    def __init__(self) -> None:
        self.sequence = 0

    async def exchange(self, kind: str, value: object) -> object:
        self.sequence += 1
        frame = canonical_json({"kind": kind, "sequence": self.sequence, "value": value})
        sys.stdout.write(frame + "\n")
        sys.stdout.flush()
        raw = await asyncio.to_thread(sys.stdin.buffer.readline, 4194305)
        if not raw or len(raw) > 4194304 or not raw.endswith(b"\n"):
            raise ValueError("private_controller_protocol_refused")
        reply: object = json.loads(raw)
        if (
            not isinstance(reply, dict)
            or set(reply) != {"sequence", "value"}
            or reply["sequence"] != self.sequence
        ):
            raise ValueError("private_controller_protocol_refused")
        return reply["value"]


class ControllerPorts:
    def __init__(self, channel: PrivateStdio, binding: AccountingBinding) -> None:
        self.channel = channel
        self.binding = binding
        self.loaded = False

    async def require_current(self, binding: AccountingBinding) -> None:
        if binding != self.binding or await self.channel.exchange("current", None) is not True:
            raise ValueError("current_authority_refused")

    async def call(self, name: str, arguments: dict[str, object]) -> object:
        # Frozen zero-only renderer never begins or finishes a model call.
        # Malicious complete frames are rejected before SDK/network/SQL begin.
        if (
            name != "load_model_accounting_dispatch"
            or self.loaded
            or arguments != ModelCallStore.arguments(self.binding)
        ):
            raise ValueError("zero_only_accounting_operation_refused")
        self.loaded = True
        return await self.channel.exchange("accounting_dispatch", None)

    async def render(self, input_text: str) -> object:
        return await self.channel.exchange("render", {"input_text": input_text})


async def main() -> None:
    raw = await asyncio.to_thread(sys.stdin.buffer.readline, 2097153)
    if not raw or len(raw) > 2097152 or not raw.endswith(b"\n"):
        raise ValueError("private_controller_protocol_refused")
    request = ProcessInput.model_validate_json(raw)
    channel = PrivateStdio()
    ports = ControllerPorts(channel, request.binding)
    output, failure = await compute_zero_only(
        request.binding, request.input_text, ports, ports, ports
    )
    sys.stdout.write(
        canonical_json({"kind": "terminal", "output_text": output, "failure_code": failure}) + "\n"
    )
    sys.stdout.flush()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        # Never print source, credentials, traceback or a private controller frame.
        sys.stderr.write("Prativedan accounted computation refused.\n")
        raise SystemExit(1) from None
