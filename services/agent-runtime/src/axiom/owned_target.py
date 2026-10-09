"""Unwired local owned-fixture execution port; never a customer connector.

Only a server-configured literal loopback target with an exact fixture/resource
identity is permitted. Reviews measure actual persisted state. External writes
use a target-owned operation journal and CAS, then independent GET readback.
These components do not issue human approval or settle application records.
"""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt

from .write_adapters import WriteRefused, WriteResult

ACTION = "config.audit_log_enable"
MAX_BYTES = 16_384
TIMEOUT = 2.0


def digest(value: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


class Snapshot(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    fixture_id: UUID
    resource_id: UUID
    version: StrictInt = Field(ge=0)
    audit_log_enabled: StrictBool

    @property
    def content_sha256(self) -> str:
        return digest({"audit_log_enabled": self.audit_log_enabled})

    @property
    def sha256(self) -> str:
        return digest(self.model_dump(mode="json"))


class Operation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    operation_id: UUID
    body_sha256: str = Field(pattern="^[a-f0-9]{64}$")
    before: Snapshot
    after: Snapshot


@dataclass(frozen=True)
class MeasuredReview:
    before: Snapshot
    desired_enabled: bool

    @property
    def parameters(self) -> dict[str, Any]:
        return {"enabled": self.desired_enabled}

    @property
    def rollback_definition(self) -> dict[str, Any]:
        return {"enabled": self.before.audit_log_enabled, "snapshot_sha256": self.before.sha256}

    @property
    def diff(self) -> dict[str, Any]:
        return {
            "simulated_from": "owned_fixture_persisted_snapshot",
            "source_snapshot_sha256": self.before.sha256,
            "source_content_sha256": self.before.content_sha256,
            "source_version": self.before.version,
            "records_measured": 1,
            "changes": [
                {
                    "field": "audit_log_enabled",
                    "before": self.before.audit_log_enabled,
                    "after": self.desired_enabled,
                }
            ],
            "rollback_simulation": {
                "method": "read_only_boolean_schema_and_original_snapshot",
                "restores_snapshot_sha256": self.before.sha256,
            },
        }


class OwnedTarget:
    def __init__(self, *, origin: str, fixture_id: UUID, resource_id: UUID, token: str):
        parsed = urlsplit(origin)
        try:
            address = ipaddress.ip_address(parsed.hostname or "")
            port = parsed.port
        except ValueError:
            raise ValueError("owned fixture requires literal loopback origin") from None
        if (
            parsed.scheme != "http"
            or not address.is_loopback
            or not port
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
            or not token
        ):
            raise ValueError("owned fixture requires authenticated literal loopback origin")
        self.origin = origin.rstrip("/")
        self.fixture_id = UUID(str(fixture_id))
        self.resource_id = UUID(str(resource_id))
        self._token = token

    async def _request(
        self, method: str, path: str, body: dict[str, Any] | None = None, *, missing: bool = False
    ) -> dict[str, Any] | None:
        try:
            async with asyncio.timeout(TIMEOUT):
                async with httpx.AsyncClient(
                    timeout=TIMEOUT, follow_redirects=False, trust_env=False
                ) as client:
                    async with client.stream(
                        method,
                        self.origin + path,
                        json=body,
                        headers={
                            "Authorization": f"Bearer {self._token}",
                            "Accept-Encoding": "identity",
                        },
                    ) as response:
                        if missing and response.status_code == 404:
                            return None
                        if response.status_code != 200:
                            raise WriteRefused("owned_target_refused")
                        if response.headers.get("content-encoding", "identity") != "identity":
                            raise WriteRefused("owned_target_response_invalid")
                        content = bytearray()
                        async for raw in response.aiter_raw():
                            if len(content) + len(raw) > MAX_BYTES:
                                raise WriteRefused("owned_target_response_invalid")
                            content.extend(raw)
                        value = json.loads(content)
                        if not isinstance(value, dict):
                            raise WriteRefused("owned_target_response_invalid")
                        return value
        except (httpx.HTTPError, TimeoutError):
            raise WriteRefused("owned_target_outcome_unknown") from None
        except (ValueError, UnicodeError, RecursionError):
            raise WriteRefused("owned_target_response_invalid") from None

    def _snapshot(self, raw: dict[str, Any]) -> Snapshot:
        try:
            result = Snapshot.model_validate(raw)
        except ValueError:
            raise WriteRefused("owned_target_response_invalid") from None
        if result.fixture_id != self.fixture_id or result.resource_id != self.resource_id:
            raise WriteRefused("owned_target_identity_mismatch")
        return result

    async def read(self) -> Snapshot:
        raw = await self._request("GET", "/resource")
        if raw is None:
            raise WriteRefused("owned_target_response_invalid")
        return self._snapshot(raw)

    async def operation(self, operation_id: UUID, body: dict[str, Any]) -> Operation | None:
        raw = await self._request("GET", f"/operations/{operation_id}", missing=True)
        if raw is None:
            return None
        try:
            result = Operation.model_validate(raw)
        except ValueError:
            raise WriteRefused("owned_target_operation_unconfirmed") from None
        before = self._snapshot(result.before.model_dump(mode="json"))
        after = self._snapshot(result.after.model_dump(mode="json"))
        if (
            result.operation_id != operation_id
            or result.body_sha256 != digest(body)
            or before.version != body["expected_version"]
            or before.sha256 != body["expected_sha256"]
            or after.version != before.version + 1
            or after.audit_log_enabled is not body["enabled"]
        ):
            raise WriteRefused("owned_target_operation_unconfirmed")
        return result

    async def change(self, operation_id: UUID, before: Snapshot, enabled: bool) -> Operation:
        if type(enabled) is not bool:
            raise WriteRefused("owned_target_parameters_invalid")
        if before.fixture_id != self.fixture_id or before.resource_id != self.resource_id:
            raise WriteRefused("owned_target_identity_mismatch")
        body = {
            "fixture_id": str(self.fixture_id),
            "resource_id": str(self.resource_id),
            "expected_version": before.version,
            "expected_sha256": before.sha256,
            "enabled": enabled,
        }
        recorded = await self.operation(operation_id, body)
        if recorded is None:
            if await self.read() != before:
                # A concurrent exact operation may have committed since the first GET.
                recorded = await self.operation(operation_id, body)
                if recorded is None:
                    raise WriteRefused("owned_target_source_changed")
            else:
                try:
                    await self._request("POST", f"/operations/{operation_id}", body)
                except WriteRefused as refused:
                    if refused.reason != "owned_target_outcome_unknown":
                        raise
                recorded = await self.operation(operation_id, body)
        if recorded is None:
            raise WriteRefused("owned_target_operation_unconfirmed")
        if await self.read() != recorded.after:
            raise WriteRefused("owned_target_readback_mismatch")
        return recorded


async def measure(target: OwnedTarget, *, enabled: bool) -> MeasuredReview:
    if type(enabled) is not bool:
        raise WriteRefused("owned_target_parameters_invalid")
    before = await target.read()
    if before.audit_log_enabled is enabled:
        raise WriteRefused("owned_target_no_change")
    return MeasuredReview(before, enabled)


class OwnedWriteAdapter:
    """One immutable reviewed action and undo; approval must be checked upstream."""

    def __init__(
        self, target: OwnedTarget, review: MeasuredReview, *, operation_id: UUID, rollback_id: UUID
    ):
        operation_id, rollback_id = UUID(str(operation_id)), UUID(str(rollback_id))
        if operation_id == rollback_id:
            raise ValueError("forward and rollback operation identities must differ")
        if (
            review.before.fixture_id != target.fixture_id
            or review.before.resource_id != target.resource_id
            or type(review.desired_enabled) is not bool
            or review.before.audit_log_enabled is review.desired_enabled
        ):
            raise ValueError("review must bind exact owned target and a boolean change")
        self.target = target
        self.review = review
        self.operation_id = UUID(str(operation_id))
        self.rollback_id = UUID(str(rollback_id))

    def _scope(self, action_type: str, body: dict[str, Any], expected: dict[str, Any]) -> None:
        if action_type != ACTION or digest(body) != digest(expected):
            raise WriteRefused("owned_target_scope_mismatch")

    @staticmethod
    def _result(op: Operation) -> WriteResult:
        return WriteResult(
            1,
            f"owned-fixture/snapshot/{op.before.sha256}",
            f"owned-fixture/snapshot/{op.after.sha256}",
        )

    async def execute(self, action_type: str, parameters: dict[str, Any]) -> WriteResult:
        self._scope(action_type, parameters, self.review.parameters)
        return self._result(
            await self.target.change(
                self.operation_id, self.review.before, self.review.desired_enabled
            )
        )

    def _forward_body(self) -> dict[str, Any]:
        return {
            "fixture_id": str(self.target.fixture_id),
            "resource_id": str(self.target.resource_id),
            "expected_version": self.review.before.version,
            "expected_sha256": self.review.before.sha256,
            "enabled": self.review.desired_enabled,
        }

    async def _forward(self) -> Operation:
        op = await self.target.operation(self.operation_id, self._forward_body())
        if op is None or op.before != self.review.before:
            raise WriteRefused("owned_target_forward_unconfirmed")
        return op

    async def simulate_rollback(self, action_type: str, definition: dict[str, Any]) -> WriteResult:
        self._scope(action_type, definition, self.review.rollback_definition)
        op = await self._forward()
        if await self.target.read() != op.after:
            raise WriteRefused("owned_target_source_changed")
        return WriteResult(
            0,
            f"owned-fixture/snapshot/{op.after.sha256}",
            f"owned-fixture/original/{op.before.sha256}",
        )

    async def execute_rollback(self, action_type: str, definition: dict[str, Any]) -> WriteResult:
        self._scope(action_type, definition, self.review.rollback_definition)
        op = await self._forward()
        restored = await self.target.change(
            self.rollback_id, op.after, self.review.before.audit_log_enabled
        )
        if restored.after.content_sha256 != self.review.before.content_sha256:
            raise WriteRefused("owned_target_rollback_readback_mismatch")
        return self._result(restored)

    async def verify(self, action_type: str, parameters: dict[str, Any]) -> list[dict[str, Any]]:
        self._scope(action_type, parameters, self.review.parameters)
        op = await self._forward()
        actual = await self.target.read()
        return [
            {
                "check_id": "owned_fixture.audit_log_enabled",
                "outcome": "passed"
                if actual == op.after and actual.audit_log_enabled is self.review.desired_enabled
                else "failed",
            }
        ]
